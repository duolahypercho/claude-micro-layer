import assert from "node:assert/strict";
import test from "node:test";

import {
  createLaunchAgentPlist,
  focusHelperPaths,
} from "../src/focus-helper.mjs";

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
