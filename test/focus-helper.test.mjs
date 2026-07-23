import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FOCUS_HELPER_SOURCES,
  createLaunchAgentPlist,
  focusHelperCompileArgs,
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

test("focus helper compiles both Swift sources with IOKit for lights", () => {
  assert.deepEqual(
    FOCUS_HELPER_SOURCES.map((path) => path.split("/").pop()),
    ["ClaudeMicroFocus.swift", "ClaudeMicroLights.swift"],
  );

  const args = focusHelperCompileArgs(FOCUS_HELPER_SOURCES, "/tmp/out");
  for (const source of FOCUS_HELPER_SOURCES) assert.ok(args.includes(source));
  assert.ok(args.includes("IOKit"));
  assert.deepEqual(args.slice(-2), ["-o", "/tmp/out"]);
});

test(
  "focus helper Swift sources compile on macOS",
  { skip: process.platform !== "darwin" },
  async () => {
    const temporaryDirectory = await mkdtemp(
      join(os.tmpdir(), "claude-micro-focus-test-"),
    );
    await execFileAsync(
      "/usr/bin/swiftc",
      focusHelperCompileArgs(
        [
          resolve(testDirectory, "../macos/ClaudeMicroFocus.swift"),
          resolve(testDirectory, "../macos/ClaudeMicroLights.swift"),
        ],
        join(temporaryDirectory, "claude-micro-focus"),
      ),
    );
  },
);
