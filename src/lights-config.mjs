import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join } from "node:path";

// The lights configuration is shared with the compiled claude-micro-focus
// helper, which re-reads it on every poll. Keep field names in sync with
// macos/ClaudeMicroLights.swift.

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MIN_POLL_INTERVAL_MS = 500;

export const DEFAULT_LIGHTS_CONFIG = Object.freeze({
  enabled: false,
  pollIntervalMs: 2000,
  rpcTimeoutMs: 75000,
  claudeLayerIndex: -1,
  colors: Object.freeze({
    pass: "#22C55E",
    active: "#F59E0B",
    done: "#EF4444",
  }),
});

export function lightsConfigPath(homeDirectory = os.homedir()) {
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "ClaudeMicroLayer",
    "lights.json",
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateLightsConfig(config) {
  assert(
    config && typeof config === "object",
    "Lights configuration must be an object",
  );
  assert(
    typeof config.enabled === "boolean",
    "lights.enabled must be a boolean",
  );
  assert(
    Number.isInteger(config.pollIntervalMs) &&
      config.pollIntervalMs >= MIN_POLL_INTERVAL_MS,
    `lights.pollIntervalMs must be an integer of at least ${MIN_POLL_INTERVAL_MS}`,
  );
  assert(
    Number.isInteger(config.rpcTimeoutMs) &&
      config.rpcTimeoutMs >= 2000 &&
      config.rpcTimeoutMs <= 120000,
    "lights.rpcTimeoutMs must be an integer between 2000 and 120000",
  );
  assert(
    Number.isInteger(config.claudeLayerIndex) && config.claudeLayerIndex >= -1,
    "lights.claudeLayerIndex must be -1 (no layer gating) or a zero-based layer index",
  );
  assert(
    config.colors && typeof config.colors === "object",
    "lights.colors must be an object",
  );
  for (const name of ["pass", "active", "done"]) {
    assert(
      typeof config.colors[name] === "string" &&
        HEX_COLOR.test(config.colors[name]),
      `lights.colors.${name} must be a #RRGGBB color`,
    );
  }
  return true;
}

export async function readLightsConfig({ homeDirectory = os.homedir() } = {}) {
  const path = lightsConfigPath(homeDirectory);
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...DEFAULT_LIGHTS_CONFIG, colors: { ...DEFAULT_LIGHTS_CONFIG.colors } };
    }
    throw new Error(`Unable to read ${path}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }

  // "error" was the earlier name for the same red; keep older files loading.
  const { error: legacyDone, ...parsedColors } = parsed.colors ?? {};
  const config = {
    ...DEFAULT_LIGHTS_CONFIG,
    ...parsed,
    colors: {
      ...DEFAULT_LIGHTS_CONFIG.colors,
      ...(legacyDone ? { done: legacyDone } : {}),
      ...parsedColors,
    },
  };
  validateLightsConfig(config);
  return config;
}

export async function writeLightsConfig(
  config,
  { homeDirectory = os.homedir() } = {},
) {
  validateLightsConfig(config);
  const path = lightsConfigPath(homeDirectory);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
  return path;
}

export async function setLightsEnabled(
  enabled,
  { homeDirectory = os.homedir() } = {},
) {
  const config = await readLightsConfig({ homeDirectory });
  const updated = { ...config, enabled };
  const path = await writeLightsConfig(updated, { homeDirectory });
  return { config: updated, path };
}
