import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MATRIX_WIDTHS = [2, 4, 4, 3];
const MAX_LAYER = 6;

export async function loadJson(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateKeyRows(rows, label) {
  assert(Array.isArray(rows), `${label} must be an array`);
  assert(rows.length === MATRIX_WIDTHS.length, `${label} must contain ${MATRIX_WIDTHS.length} rows`);

  rows.forEach((row, rowIndex) => {
    assert(Array.isArray(row), `${label}[${rowIndex}] must be an array`);
    assert(
      row.length === MATRIX_WIDTHS[rowIndex],
      `${label}[${rowIndex}] must contain ${MATRIX_WIDTHS[rowIndex]} keys`,
    );
    row.forEach((key, keyIndex) => {
      assert(
        typeof key === "string" && key.length > 0,
        `${label}[${rowIndex}][${keyIndex}] must be a non-empty keycode`,
      );
    });
  });
}

function validateLayer(layer, label = "layer") {
  assert(layer && typeof layer === "object", `${label} must be an object`);
  assert(typeof layer.name === "string" && layer.name.trim(), `${label}.name is required`);
  assert(layer.layout && typeof layer.layout === "object", `${label}.layout is required`);
  validateKeyRows(layer.layout.keymap, `${label}.layout.keymap`);

  if (layer.layout.encoders !== undefined) {
    assert(
      Array.isArray(layer.layout.encoders) &&
        layer.layout.encoders.length === 1 &&
        Array.isArray(layer.layout.encoders[0]) &&
        layer.layout.encoders[0].length === 3,
      `${label}.layout.encoders must contain one row of three keycodes`,
    );
    layer.layout.encoders[0].forEach((key, index) => {
      assert(typeof key === "string" && key.length > 0, `${label}.layout.encoders[0][${index}] is invalid`);
    });
  }
}

export function validateLayerPack(layerPack) {
  assert(layerPack && typeof layerPack === "object", "Layer pack must be an object");
  assert(layerPack.formatVersion === 1, "Unsupported layer pack formatVersion; expected 1");
  assert(layerPack.device === "codex_micro", "Layer pack device must be codex_micro");
  assert(typeof layerPack.name === "string" && layerPack.name.trim(), "Layer pack name is required");
  validateLayer(layerPack.layer, "layerPack.layer");
  return true;
}

export function validateInputKeymap(keymap) {
  assert(keymap && typeof keymap === "object", "Input keymap must be an object");
  assert(keymap.version === 1, "Unsupported Input keymap version; expected 1");
  assert(Array.isArray(keymap.profiles) && keymap.profiles.length > 0, "Input keymap has no profiles");

  for (const profile of keymap.profiles) {
    assert(Array.isArray(profile.layers) && profile.layers.length > 0, `Profile ${profile.id} has no layers`);
    validateLayer(profile.layers[0], `Profile ${profile.id} Layer 1`);
  }
  return true;
}

function getProfile(keymap, profileId) {
  const profile = keymap.profiles.find((candidate) => candidate.id === profileId);
  assert(profile, `Profile ${profileId} was not found`);
  return profile;
}

function blankLayer(id) {
  return {
    id,
    name: `Layer ${id + 1}`,
    color: 16711680,
    layout: {
      keymap: MATRIX_WIDTHS.map((width) => Array.from({ length: width }, () => "KC_NONE")),
      encoders: [["KC_NONE", "KC_NONE", "KC_NONE"]],
      joystick: { type: "RADIAL", sectors: [] },
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

export function applyLayerPack(keymap, layerPack, { layerNumber, profileId = 0 }) {
  validateInputKeymap(keymap);
  validateLayerPack(layerPack);
  assert(Number.isInteger(layerNumber), "Layer number must be an integer");
  assert(layerNumber >= 2 && layerNumber <= MAX_LAYER, "Layer number must be between 2 and 6");

  const updatedKeymap = clone(keymap);
  const sourceProfile = getProfile(keymap, profileId);
  const targetProfile = getProfile(updatedKeymap, profileId);
  const protectedLayer = JSON.stringify(sourceProfile.layers[0]);
  const targetIndex = layerNumber - 1;

  while (targetProfile.layers.length <= targetIndex) {
    targetProfile.layers.push(blankLayer(targetProfile.layers.length));
  }

  targetProfile.layers[targetIndex] = {
    ...clone(layerPack.layer),
    id: targetIndex,
  };

  assert(
    JSON.stringify(targetProfile.layers[0]) === protectedLayer,
    "Refusing to modify Codex-controlled Layer 1",
  );
  validateInputKeymap(updatedKeymap);
  return updatedKeymap;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function installLayer({
  keymapPath,
  layerPackPath,
  layerNumber,
  profileId = 0,
  dryRun = false,
}) {
  const [keymap, layerPack] = await Promise.all([loadJson(keymapPath), loadJson(layerPackPath)]);
  const updatedKeymap = applyLayerPack(keymap, layerPack, { layerNumber, profileId });

  if (dryRun) {
    return { dryRun: true, layerName: layerPack.name, layerNumber };
  }

  const backupPath = `${keymapPath}.backup-${timestamp()}`;
  await copyFile(keymapPath, backupPath, constants.COPYFILE_EXCL);
  await writeJsonAtomic(keymapPath, updatedKeymap);
  return { dryRun: false, backupPath, layerName: layerPack.name, layerNumber };
}

export function createLayerPackFromKeymap(keymap, { layerNumber, profileId = 0 }) {
  validateInputKeymap(keymap);
  assert(Number.isInteger(layerNumber), "Layer number must be an integer");
  assert(layerNumber >= 2 && layerNumber <= MAX_LAYER, "Layer number must be between 2 and 6");

  const profile = getProfile(keymap, profileId);
  const layer = profile.layers[layerNumber - 1];
  assert(layer, `Layer ${layerNumber} was not found in profile ${profileId}`);

  const portableLayer = clone(layer);
  delete portableLayer.id;

  return {
    formatVersion: 1,
    device: "codex_micro",
    name: portableLayer.name,
    description: `Exported from Input profile ${profileId}, layer ${layerNumber}.`,
    layer: portableLayer,
  };
}

export async function exportLayer({
  keymapPath,
  outputPath,
  layerNumber,
  profileId = 0,
}) {
  const keymap = await loadJson(keymapPath);
  const layerPack = createLayerPackFromKeymap(keymap, { layerNumber, profileId });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeJsonAtomic(outputPath, layerPack);
  return { layerName: layerPack.name, outputPath };
}

function inputDataRoots() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", "input", "devices")];
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return [join(process.env.APPDATA, "input", "devices")];
  }
  return [join(home, ".config", "input", "devices")];
}

export async function detectKeymaps() {
  const results = [];

  for (const root of inputDataRoots()) {
    try {
      await access(root, constants.R_OK);
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = resolve(root, entry.name, "keymap.json");
        try {
          await access(candidate, constants.R_OK | constants.W_OK);
          results.push(candidate);
        } catch {
          // Ignore device directories without a writable keymap.
        }
      }
    } catch {
      // Input has not created a device directory on this platform.
    }
  }

  return results.sort();
}
