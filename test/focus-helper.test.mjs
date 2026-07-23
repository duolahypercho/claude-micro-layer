import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createLaunchAgentPlist,
  focusHelperPaths,
} from "../src/focus-helper.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));

test("focus helper uses stable per-user installation paths", () => {
  const paths = focusHelperPaths("/Users/example");

  assert.equal(
    paths.executablePath,
    "/Users/example/Library/Application Support/ClaudeMicroLayer/claude-micro-focus",
  );
  assert.equal(
    paths.launchAgentPath,
    "/Users/example/Library/LaunchAgents/cc.worklouder.claude-micro-focus.plist",
  );
});

test("focus helper launch agent starts the exact installed executable", () => {
  const plist = createLaunchAgentPlist(
    "/Users/A & B/ClaudeMicroLayer/claude-micro-focus",
  );

  assert.match(plist, /cc\.worklouder\.claude-micro-focus/);
  assert.match(plist, /\/Users\/A &amp; B\/ClaudeMicroLayer/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test(
  "focus helper Swift source compiles on macOS",
  { skip: process.platform !== "darwin" },
  async () => {
    const temporaryDirectory = await mkdtemp(
      join(os.tmpdir(), "claude-micro-focus-test-"),
    );
    await execFileAsync("/usr/bin/swiftc", [
      resolve(testDirectory, "../macos/ClaudeMicroFocus.swift"),
      "-framework",
      "Cocoa",
      "-framework",
      "Carbon",
      "-framework",
      "ApplicationServices",
      "-o",
      join(temporaryDirectory, "claude-micro-focus"),
    ]);
  },
);
