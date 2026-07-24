#!/usr/bin/env node

import { resolve } from "node:path";

import { installFocusHelper } from "../src/focus-helper.mjs";
import {
  lightsConfigPath,
  readLightsConfig,
  setLightsEnabled,
} from "../src/lights-config.mjs";
import {
  detectKeymaps,
  exportLayer,
  installLayer,
  loadJson,
  validateLayerPack,
} from "../src/keymap.mjs";
import { syncInputKeymap } from "../src/input-sync.mjs";

function usage() {
  console.log(`claude-micro-layer

Usage:
  claude-micro-layer detect
  claude-micro-layer validate <layer-file>
  claude-micro-layer install <layer-file> --layer <2-6> [--profile <id>] [--keymap <path>] [--dry-run]
  claude-micro-layer sync [--keymap <path>] [--input-app <path>]
  claude-micro-layer export --layer <2-6> --output <path> [--profile <id>] [--keymap <path>]
  claude-micro-layer focus-helper install
  claude-micro-layer lights on|off|status

Input should be closed before install or sync. Install creates a timestamped
backup; sync writes the verified keymap to the keyboard, mirrors it into Input's
database so its UI matches, and reopens Input.
Lights mirror Claude chat statuses on the six task keys while Layer 2 is
active; the helper needs macOS Input Monitoring access the first time.`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const name = value.slice(2);
    if (name === "dry-run") {
      options.dryRun = true;
      continue;
    }

    const optionValue = rest[index + 1];
    if (!optionValue || optionValue.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    index += 1;

    if (name === "keymap") options.keymapPath = resolve(optionValue);
    else if (name === "input-app") options.inputAppPath = resolve(optionValue);
    else if (name === "layer") options.layerNumber = Number(optionValue);
    else if (name === "profile") options.profileId = Number(optionValue);
    else if (name === "output") options.outputPath = resolve(optionValue);
    else throw new Error(`Unknown option --${name}`);
  }

  return { command, options, positionals };
}

async function resolveKeymapPath(explicitPath) {
  if (explicitPath) return explicitPath;

  const matches = await detectKeymaps();
  if (matches.length === 0) {
    throw new Error("No Work Louder Input keymap found. Pass --keymap <path>.");
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple keymaps found. Pass --keymap with one of:\n${matches.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  return matches[0];
}

async function main() {
  const { command, options, positionals } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }

  if (command === "detect") {
    const matches = await detectKeymaps();
    if (matches.length === 0) {
      console.log("No Work Louder Input keymaps found.");
      return;
    }
    for (const path of matches) console.log(path);
    return;
  }

  if (command === "validate") {
    if (positionals.length !== 1)
      throw new Error("validate requires one layer file");
    const layerPack = await loadJson(resolve(positionals[0]));
    validateLayerPack(layerPack);
    console.log(`Valid layer pack: ${layerPack.name}`);
    return;
  }

  if (command === "install") {
    if (positionals.length !== 1)
      throw new Error("install requires one layer file");
    if (!options.layerNumber) throw new Error("install requires --layer <2-6>");

    const keymapPath = await resolveKeymapPath(options.keymapPath);
    const result = await installLayer({
      keymapPath,
      layerPackPath: resolve(positionals[0]),
      layerNumber: options.layerNumber,
      profileId: options.profileId ?? 0,
      dryRun: options.dryRun ?? false,
    });

    if (result.dryRun) {
      console.log(
        `Dry run passed: ${result.layerName} can be installed as Layer ${result.layerNumber}.`,
      );
    } else {
      console.log(
        `Installed ${result.layerName} as Layer ${result.layerNumber}.`,
      );
      console.log(`Backup: ${result.backupPath}`);
      console.log(
        "Run `node ./bin/claude-micro-layer.mjs sync` while Input is closed to update the keyboard.",
      );
    }
    return;
  }

  if (command === "sync") {
    const keymapPath = await resolveKeymapPath(options.keymapPath);
    const result = await syncInputKeymap({
      keymapPath,
      inputAppPath: options.inputAppPath,
    });
    console.log(`Synced keymap to Codex Micro device ${result.deviceId}.`);
    console.log(`Verified checksum: ${result.checksum}`);
    console.log("Work Louder Input has been reopened normally.");
    return;
  }

  if (command === "export") {
    if (!options.layerNumber) throw new Error("export requires --layer <2-6>");
    if (!options.outputPath) throw new Error("export requires --output <path>");

    const keymapPath = await resolveKeymapPath(options.keymapPath);
    const result = await exportLayer({
      keymapPath,
      outputPath: options.outputPath,
      layerNumber: options.layerNumber,
      profileId: options.profileId ?? 0,
    });
    console.log(`Exported ${result.layerName} to ${result.outputPath}`);
    return;
  }

  if (command === "focus-helper") {
    if (positionals.length !== 1 || positionals[0] !== "install") {
      throw new Error("focus-helper requires the install subcommand");
    }
    const result = await installFocusHelper();
    console.log(`Installed Claude focus helper: ${result.executablePath}`);
    console.log("Double-tap focus shortcut: Control-Option-Command-C");
    return;
  }

  if (command === "lights") {
    const subcommand = positionals[0];
    if (positionals.length !== 1 || !["on", "off", "status"].includes(subcommand)) {
      throw new Error("lights requires one subcommand: on, off, or status");
    }

    if (subcommand === "status") {
      const config = await readLightsConfig();
      console.log(`Lights are ${config.enabled ? "enabled" : "disabled"}.`);
      console.log(`Configuration: ${lightsConfigPath()}`);
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    const enabled = subcommand === "on";
    const result = await setLightsEnabled(enabled);
    console.log(`Lights ${enabled ? "enabled" : "disabled"}.`);
    console.log(`Configuration: ${result.path}`);
    if (enabled) {
      console.log(
        "The claude-micro-focus helper applies this within a few seconds.",
      );
      console.log(
        "If the helper predates lights support, reinstall it first:",
      );
      console.log("  node ./bin/claude-micro-layer.mjs focus-helper install");
      console.log(
        "macOS asks once for Input Monitoring access; grant it to claude-micro-focus under",
      );
      console.log(
        "System Settings → Privacy & Security → Input Monitoring.",
      );
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
