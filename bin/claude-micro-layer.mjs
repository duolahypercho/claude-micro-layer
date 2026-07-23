#!/usr/bin/env node

import { resolve } from "node:path";

import {
  detectKeymaps,
  exportLayer,
  installLayer,
  loadJson,
  validateLayerPack,
} from "../src/keymap.mjs";

function usage() {
  console.log(`claude-micro-layer

Usage:
  claude-micro-layer detect
  claude-micro-layer validate <layer-file>
  claude-micro-layer install <layer-file> --layer <2-6> [--profile <id>] [--keymap <path>] [--dry-run]
  claude-micro-layer export --layer <2-6> --output <path> [--profile <id>] [--keymap <path>]

Input should be closed before install. A timestamped backup is created beside
the keymap before any change is written.`);
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
    if (positionals.length !== 1) throw new Error("validate requires one layer file");
    const layerPack = await loadJson(resolve(positionals[0]));
    validateLayerPack(layerPack);
    console.log(`Valid layer pack: ${layerPack.name}`);
    return;
  }

  if (command === "install") {
    if (positionals.length !== 1) throw new Error("install requires one layer file");
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
      console.log(`Dry run passed: ${result.layerName} can be installed as Layer ${result.layerNumber}.`);
    } else {
      console.log(`Installed ${result.layerName} as Layer ${result.layerNumber}.`);
      console.log(`Backup: ${result.backupPath}`);
      console.log("Open Input to sync the updated keymap to the keyboard.");
    }
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

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
