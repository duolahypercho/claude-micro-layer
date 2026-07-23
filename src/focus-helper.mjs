import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LABEL = "cc.worklouder.claude-micro-focus";
const SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../macos/ClaudeMicroFocus.swift",
);

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createLaunchAgentPlist(executablePath) {
  const executable = xmlEscape(executablePath);
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
  <string>/dev/null</string>
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
    launchAgentPath: join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${LABEL}.plist`,
    ),
  };
}

export async function installFocusHelper({
  homeDirectory = os.homedir(),
  sourcePath = SOURCE_PATH,
  loadLaunchAgent = true,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The Claude focus helper requires macOS");
  }

  const paths = focusHelperPaths(homeDirectory);
  await mkdir(paths.supportDirectory, { recursive: true });
  await mkdir(dirname(paths.launchAgentPath), { recursive: true });

  const temporaryExecutable = `${paths.executablePath}.tmp-${process.pid}`;
  await execFileAsync("/usr/bin/swiftc", [
    sourcePath,
    "-framework",
    "Cocoa",
    "-framework",
    "Carbon",
    "-framework",
    "ApplicationServices",
    "-o",
    temporaryExecutable,
  ]);
  await rename(temporaryExecutable, paths.executablePath);

  const temporaryPlist = `${paths.launchAgentPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPlist,
    createLaunchAgentPlist(paths.executablePath),
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

  return paths;
}
