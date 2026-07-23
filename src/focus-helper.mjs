import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LABEL = "cc.worklouder.claude-micro-focus";
const SIGNING_IDENTITY = "Claude Micro Layer";
const MACOS_SOURCE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../macos",
);

export const FOCUS_HELPER_SOURCES = [
  join(MACOS_SOURCE_DIRECTORY, "ClaudeMicroFocus.swift"),
  join(MACOS_SOURCE_DIRECTORY, "ClaudeMicroLights.swift"),
];

export const FOCUS_HELPER_FRAMEWORKS = [
  "Cocoa",
  "Carbon",
  "ApplicationServices",
  "IOKit",
];

export function focusHelperCompileArgs(sources, outputPath) {
  return [
    ...sources,
    ...FOCUS_HELPER_FRAMEWORKS.flatMap((framework) => [
      "-framework",
      framework,
    ]),
    "-o",
    outputPath,
  ];
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createLaunchAgentPlist(executablePath, logPath = "/dev/null") {
  const executable = xmlEscape(executablePath);
  const log = xmlEscape(logPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executable}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export function focusHelperPaths(homeDirectory = os.homedir()) {
  const supportDirectory = join(
    homeDirectory,
    "Library",
    "Application Support",
    "ClaudeMicroLayer",
  );
  return {
    supportDirectory,
    executablePath: join(supportDirectory, "claude-micro-focus"),
    logPath: join(supportDirectory, "claude-micro-focus.log"),
    launchAgentPath: join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${LABEL}.plist`,
    ),
  };
}

// Prefer the dedicated helper identity, then any valid signing identity
// already in the keychain (for example a Developer ID certificate).
async function findSigningIdentity() {
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
    ]);
    if (stdout.includes(`"${SIGNING_IDENTITY}"`)) return SIGNING_IDENTITY;
    const firstIdentity = /^\s*\d+\)\s+([0-9A-F]{40})\s+"/m.exec(stdout);
    return firstIdentity ? firstIdentity[1] : null;
  } catch {
    return null;
  }
}

// macOS privacy grants (Accessibility, Input Monitoring) bind to the helper's
// code signature. Ad-hoc signatures change on every build, which silently
// invalidates the grants after each reinstall. A local self-signed identity
// keeps the signature requirement stable so permissions survive rebuilds.
async function ensureSigningIdentity(workDirectory) {
  const existing = await findSigningIdentity();
  if (existing) return existing;

  const keyPath = join(workDirectory, "claude-micro-layer-signing-key.pem");
  const certificatePath = join(workDirectory, "claude-micro-layer-signing.pem");
  const bundlePath = join(workDirectory, "claude-micro-layer-signing.p12");
  const bundlePassword = "claude-micro-layer";
  try {
    await execFileAsync("/usr/bin/openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "3650",
      "-nodes",
      "-subj",
      `/CN=${SIGNING_IDENTITY}`,
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=critical,codeSigning",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
    ]);
    await execFileAsync("/usr/bin/openssl", [
      "pkcs12",
      "-export",
      "-out",
      bundlePath,
      "-inkey",
      keyPath,
      "-in",
      certificatePath,
      "-password",
      `pass:${bundlePassword}`,
    ]);
    await execFileAsync("/usr/bin/security", [
      "import",
      bundlePath,
      "-P",
      bundlePassword,
      "-T",
      "/usr/bin/codesign",
    ]);
    return findSigningIdentity();
  } catch {
    return null;
  } finally {
    await Promise.allSettled([
      rm(keyPath, { force: true }),
      rm(certificatePath, { force: true }),
      rm(bundlePath, { force: true }),
    ]);
  }
}

async function signHelper(identity, executablePath) {
  await execFileAsync("/usr/bin/codesign", [
    "--force",
    "--sign",
    identity,
    "--identifier",
    LABEL,
    executablePath,
  ]);
}

export async function installFocusHelper({
  homeDirectory = os.homedir(),
  sourcePaths = FOCUS_HELPER_SOURCES,
  loadLaunchAgent = true,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The Claude focus helper requires macOS");
  }

  const paths = focusHelperPaths(homeDirectory);
  await mkdir(paths.supportDirectory, { recursive: true });
  await mkdir(dirname(paths.launchAgentPath), { recursive: true });

  const temporaryExecutable = `${paths.executablePath}.tmp-${process.pid}`;
  await execFileAsync(
    "/usr/bin/swiftc",
    focusHelperCompileArgs(sourcePaths, temporaryExecutable),
  );

  let signedStably = false;
  const identity = await ensureSigningIdentity(paths.supportDirectory);
  if (identity) {
    try {
      await signHelper(identity, temporaryExecutable);
      signedStably = true;
    } catch {
      // Fall through to the ad-hoc linker signature.
    }
  }

  await rename(temporaryExecutable, paths.executablePath);

  const temporaryPlist = `${paths.launchAgentPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPlist,
    createLaunchAgentPlist(paths.executablePath, paths.logPath),
    "utf8",
  );
  await rename(temporaryPlist, paths.launchAgentPath);

  if (loadLaunchAgent) {
    const domain = `gui/${process.getuid()}`;
    await execFileAsync("/bin/launchctl", [
      "bootout",
      `${domain}/${LABEL}`,
    ]).catch(() => {});
    await execFileAsync("/bin/launchctl", [
      "bootstrap",
      domain,
      paths.launchAgentPath,
    ]);
    await execFileAsync("/bin/launchctl", [
      "kickstart",
      "-k",
      `${domain}/${LABEL}`,
    ]);
  }

  return { ...paths, signedStably };
}
