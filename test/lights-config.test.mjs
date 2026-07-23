import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_LIGHTS_CONFIG,
  lightsConfigPath,
  readLightsConfig,
  setLightsEnabled,
  validateLightsConfig,
  writeLightsConfig,
} from "../src/lights-config.mjs";

async function temporaryHome() {
  return mkdtemp(join(os.tmpdir(), "claude-micro-lights-test-"));
}

test("lights configuration lives next to the focus helper", () => {
  assert.equal(
    lightsConfigPath("/Users/example"),
    "/Users/example/Library/Application Support/ClaudeMicroLayer/lights.json",
  );
});

test("missing configuration falls back to safe defaults", async () => {
  const homeDirectory = await temporaryHome();

  const config = await readLightsConfig({ homeDirectory });

  assert.equal(config.enabled, false);
  assert.equal(config.pollIntervalMs, 2000);
  assert.equal(config.claudeLayerIndex, 1);
  assert.deepEqual(config.colors, {
    pass: "#22C55E",
    active: "#F59E0B",
    error: "#EF4444",
  });
});

test("enabling lights writes a valid configuration file", async () => {
  const homeDirectory = await temporaryHome();

  const result = await setLightsEnabled(true, { homeDirectory });

  assert.equal(result.config.enabled, true);
  const written = JSON.parse(await readFile(result.path, "utf8"));
  assert.equal(written.enabled, true);
  assert.equal(written.pollIntervalMs, DEFAULT_LIGHTS_CONFIG.pollIntervalMs);
  validateLightsConfig(written);
});

test("disabling lights preserves customized fields", async () => {
  const homeDirectory = await temporaryHome();
  await writeLightsConfig(
    {
      enabled: true,
      pollIntervalMs: 3000,
      rpcTimeoutMs: 15000,
      claudeLayerIndex: 2,
      colors: { pass: "#00FF00", active: "#FFA500", error: "#FF0000" },
    },
    { homeDirectory },
  );

  const result = await setLightsEnabled(false, { homeDirectory });

  assert.equal(result.config.enabled, false);
  assert.equal(result.config.pollIntervalMs, 3000);
  assert.equal(result.config.claudeLayerIndex, 2);
  assert.equal(result.config.colors.pass, "#00FF00");
});

test("partial configuration files are filled with defaults", async () => {
  const homeDirectory = await temporaryHome();
  const path = lightsConfigPath(homeDirectory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{"enabled": true}\n', "utf8");

  const config = await readLightsConfig({ homeDirectory });

  assert.equal(config.enabled, true);
  assert.equal(config.pollIntervalMs, DEFAULT_LIGHTS_CONFIG.pollIntervalMs);
  assert.deepEqual(config.colors, DEFAULT_LIGHTS_CONFIG.colors);
});

test("invalid JSON is reported with the file path", async () => {
  const homeDirectory = await temporaryHome();
  const path = lightsConfigPath(homeDirectory);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not json", "utf8");

  await assert.rejects(
    () => readLightsConfig({ homeDirectory }),
    /Invalid JSON in .*lights\.json/,
  );
});

test("validation rejects malformed configurations", () => {
  const base = {
    enabled: true,
    pollIntervalMs: 2000,
    rpcTimeoutMs: 10000,
    claudeLayerIndex: 1,
    colors: { pass: "#22C55E", active: "#F59E0B", error: "#EF4444" },
  };

  assert.equal(validateLightsConfig(base), true);
  assert.throws(
    () => validateLightsConfig({ ...base, enabled: "yes" }),
    /enabled must be a boolean/,
  );
  assert.throws(
    () => validateLightsConfig({ ...base, pollIntervalMs: 100 }),
    /pollIntervalMs/,
  );
  assert.throws(
    () => validateLightsConfig({ ...base, claudeLayerIndex: -2 }),
    /claudeLayerIndex/,
  );
  assert.throws(
    () =>
      validateLightsConfig({
        ...base,
        colors: { ...base.colors, error: "red" },
      }),
    /colors\.error/,
  );
});
