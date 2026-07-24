import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import WebSocket from "ws";

import { loadJson, validateInputKeymap } from "./keymap.mjs";
import { updateInputStore } from "./input-store.mjs";

const DEFAULT_INPUT_APP = "/Applications/input.app";
const INPUT_EXECUTABLE = join("Contents", "MacOS", "input");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

async function inputProcessIds(inputAppPath) {
  const executable = join(inputAppPath, INPUT_EXECUTABLE);
  const { stdout } = await execFileAsync("/bin/ps", [
    "-ax",
    "-o",
    "pid=,command=",
  ]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter((process) => process?.command.startsWith(executable))
    .map((process) => process.pid);
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("Unable to allocate a local Input sync port");
  return port;
}

async function waitFor(getValue, { timeoutMs, description }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await getValue();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  const suffix = lastError ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = (this.nextId += 1);
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          "Input bridge evaluation failed",
      );
    }
    return result.result.value;
  }

  close() {
    this.socket?.close();
  }
}

export function verifyDeviceKeymap(files, expectedChecksum) {
  const keymap = files.find((file) => file.name === "keymap.json");
  if (!keymap)
    throw new Error("Codex Micro did not report keymap.json after sync");
  if (keymap.checksum !== expectedChecksum) {
    throw new Error(
      `Device checksum mismatch: expected ${expectedChecksum}, received ${keymap.checksum}`,
    );
  }
  return keymap;
}

async function stopDebugInput(pid, inputAppPath) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }

  await waitFor(
    async () => {
      const ids = await inputProcessIds(inputAppPath);
      return !ids.includes(pid);
    },
    { timeoutMs: 10_000, description: "temporary Input process to close" },
  );
}

export async function syncInputKeymap({
  keymapPath,
  inputAppPath = DEFAULT_INPUT_APP,
  timeoutMs = 30_000,
}) {
  const runningIds = await inputProcessIds(inputAppPath);
  if (runningIds.length > 0) {
    throw new Error("Quit Work Louder Input before running sync");
  }

  const [keymap, keymapText] = await Promise.all([
    loadJson(keymapPath),
    readFile(keymapPath, "utf8"),
  ]);
  validateInputKeymap(keymap);

  const expectedChecksum = createHash("sha1").update(keymapText).digest("hex");
  const port = await getFreePort();
  let cdp;
  let debugPid;
  let launched = false;

  try {
    await execFileAsync("/usr/bin/open", [
      "-n",
      inputAppPath,
      "--args",
      `--remote-debugging-port=${port}`,
    ]);
    launched = true;

    debugPid = await waitFor(
      async () => (await inputProcessIds(inputAppPath))[0],
      { timeoutMs: 10_000, description: "Work Louder Input to launch" },
    );

    const target = await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/json`);
        if (!response.ok) return null;
        const targets = await response.json();
        return targets.find((candidate) =>
          candidate.url.includes("index.html"),
        );
      },
      { timeoutMs: 10_000, description: "Input's local device bridge" },
    );

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();

    const device = await waitFor(
      async () => {
        const devices = await cdp.evaluate(`(async () =>
          (await devicesManagerChannel.getDevices())
            .filter(device => device.deviceType === "codex_micro" && device.isConnected)
        )()`);
        if (devices.length > 1)
          throw new Error("Multiple connected Codex Micro devices found");
        return devices[0];
      },
      {
        timeoutMs,
        description:
          "Codex Micro to connect; wake it with a normal key if needed",
      },
    );

    const beforeFiles = await cdp.evaluate(
      `(async () => rpcChannel.getFileList(${JSON.stringify(device.id)}))()`,
    );
    const base64Keymap = Buffer.from(keymapText, "utf8").toString("base64");
    const writeResult = await cdp.evaluate(`(async () => {
      const binary = atob(${JSON.stringify(base64Keymap)});
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return rpcChannel.writeFileChunked(
        ${JSON.stringify(device.id)},
        "keymap.json",
        bytes
      );
    })()`);
    if (writeResult !== true)
      throw new Error("Input reported that the keymap write failed");

    const verifiedFile = await waitFor(
      async () => {
        const files = await cdp.evaluate(
          `(async () => rpcChannel.getFileList(${JSON.stringify(device.id)}))()`,
        );
        try {
          return verifyDeviceKeymap(files, expectedChecksum);
        } catch {
          return null;
        }
      },
      {
        timeoutMs: 10_000,
        description: "Codex Micro to report the new checksum",
      },
    );

    return {
      deviceId: device.id,
      previousChecksum: beforeFiles.find((file) => file.name === "keymap.json")
        ?.checksum,
      checksum: verifiedFile.checksum,
      size: verifiedFile.size,
    };
  } finally {
    cdp?.close();
    try {
      if (!debugPid && launched) {
        debugPid = (await inputProcessIds(inputAppPath))[0];
      }
      if (debugPid) await stopDebugInput(debugPid, inputAppPath);
      // With Input closed, mirror the keymap into its database so its UI shows
      // the synced layer and never re-pushes a stale copy. A store failure must
      // not fail the sync — the keyboard is already updated.
      try {
        await updateInputStore(keymap);
      } catch {
        // Leave the database as it was; the keyboard sync still succeeded.
      }
    } finally {
      if (launched) await execFileAsync("/usr/bin/open", [inputAppPath]);
    }
  }
}
