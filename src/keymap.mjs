import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MATRIX_WIDTHS = [2, 4, 4, 3];
const MAX_LAYER = 6;
const PORTABLE_ACTION_REF = /^KA_(\d+)$/;
const DEVICE_ACTION_REF = /^KA_A(\d+)$/;
const PORTABLE_MULTI_ACTION_REF = /^KM_(\d+)$/;
const DEVICE_MULTI_ACTION_REF = /^KA_M(\d+)$/;
const MULTI_ACTION_INPUTS = ["tap", "onHold", "doubleTap", "tapHold"];

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
  assert(
    rows.length === MATRIX_WIDTHS.length,
    `${label} must contain ${MATRIX_WIDTHS.length} rows`,
  );

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
  assert(
    typeof layer.name === "string" && layer.name.trim(),
    `${label}.name is required`,
  );
  assert(
    layer.layout && typeof layer.layout === "object",
    `${label}.layout is required`,
  );
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
      assert(
        typeof key === "string" && key.length > 0,
        `${label}.layout.encoders[0][${index}] is invalid`,
      );
    });
  }
}

function layerKeycodes(layer) {
  const keycodes = layer.layout.keymap.flat();
  if (layer.layout.encoders) keycodes.push(...layer.layout.encoders.flat());
  if (layer.layout.joystick?.sectors) {
    keycodes.push(...layer.layout.joystick.sectors.map((sector) => sector.k));
  }
  return keycodes;
}

function mapLayerKeycodes(layer, mapper) {
  const mapped = clone(layer);
  mapped.layout.keymap = mapped.layout.keymap.map((row) => row.map(mapper));
  if (mapped.layout.encoders) {
    mapped.layout.encoders = mapped.layout.encoders.map((row) =>
      row.map(mapper),
    );
  }
  if (mapped.layout.joystick?.sectors) {
    mapped.layout.joystick.sectors = mapped.layout.joystick.sectors.map(
      (sector) => ({
        ...sector,
        k: mapper(sector.k),
      }),
    );
  }
  return mapped;
}

function validateLinkedApp(linkedApp, label) {
  assert(
    linkedApp && typeof linkedApp === "object",
    `${label} must be an object`,
  );
  assert(
    (typeof linkedApp.process === "string" && linkedApp.process.trim()) ||
      (typeof linkedApp.path === "string" && linkedApp.path.trim()),
    `${label} needs a process bundle id or an app path`,
  );
  for (const field of ["name", "process", "path"]) {
    if (linkedApp[field] !== undefined) {
      assert(
        typeof linkedApp[field] === "string",
        `${label}.${field} must be a string`,
      );
    }
  }
}

function validateKeyInput(input, label) {
  assert(input && typeof input === "object", `${label} must be an object`);
  assert(
    typeof input.keycode === "string" && input.keycode,
    `${label}.keycode is required`,
  );
  assert(
    Number.isInteger(input.delay) && input.delay >= 0,
    `${label}.delay is invalid`,
  );
  assert(
    [0, 1, 2].includes(input.actionType),
    `${label}.actionType must be 0, 1, or 2`,
  );
}

function validateActions(actions) {
  assert(Array.isArray(actions), "layerPack.actions must be an array");
  const ids = new Set();

  actions.forEach((action, actionIndex) => {
    const label = `layerPack.actions[${actionIndex}]`;
    assert(action && typeof action === "object", `${label} must be an object`);
    assert(
      Number.isInteger(action.id) && action.id >= 0,
      `${label}.id must be a non-negative integer`,
    );
    assert(!ids.has(action.id), `${label}.id must be unique`);
    ids.add(action.id);
    assert(
      typeof action.name === "string" && action.name.trim(),
      `${label}.name is required`,
    );
    assert(
      Array.isArray(action.keyInputs) && action.keyInputs.length > 0,
      `${label}.keyInputs is required`,
    );

    action.keyInputs.forEach((input, inputIndex) =>
      validateKeyInput(input, `${label}.keyInputs[${inputIndex}]`),
    );
  });

  return ids;
}

function validateMultiActions(multiActions) {
  assert(Array.isArray(multiActions), "layerPack.multiActions must be an array");
  const ids = new Set();

  multiActions.forEach((multiAction, index) => {
    const label = `layerPack.multiActions[${index}]`;
    assert(
      multiAction && typeof multiAction === "object",
      `${label} must be an object`,
    );
    assert(
      Number.isInteger(multiAction.id) && multiAction.id >= 0,
      `${label}.id must be a non-negative integer`,
    );
    assert(!ids.has(multiAction.id), `${label}.id must be unique`);
    ids.add(multiAction.id);
    assert(
      typeof multiAction.name === "string" && multiAction.name.trim(),
      `${label}.name is required`,
    );
    assert(
      Number.isInteger(multiAction.tappingTerms) &&
        multiAction.tappingTerms >= 100 &&
        multiAction.tappingTerms <= 1000,
      `${label}.tappingTerms must be between 100 and 1000 milliseconds`,
    );
    for (const inputName of MULTI_ACTION_INPUTS) {
      validateKeyInput(multiAction[inputName], `${label}.${inputName}`);
    }
  });

  return ids;
}

export function validateLayerPack(layerPack) {
  assert(
    layerPack && typeof layerPack === "object",
    "Layer pack must be an object",
  );
  assert(
    layerPack.formatVersion === 1,
    "Unsupported layer pack formatVersion; expected 1",
  );
  assert(
    layerPack.device === "codex_micro",
    "Layer pack device must be codex_micro",
  );
  assert(
    typeof layerPack.name === "string" && layerPack.name.trim(),
    "Layer pack name is required",
  );
  validateLayer(layerPack.layer, "layerPack.layer");
  if (layerPack.linkedApp !== undefined) {
    validateLinkedApp(layerPack.linkedApp, "layerPack.linkedApp");
  }

  const actionIds = validateActions(layerPack.actions ?? []);
  const multiActionIds = validateMultiActions(layerPack.multiActions ?? []);
  const referencedKeycodes = [
    ...layerKeycodes(layerPack.layer),
    ...(layerPack.actions ?? []).flatMap((action) =>
      action.keyInputs.map((input) => input.keycode),
    ),
    ...(layerPack.multiActions ?? []).flatMap((multiAction) =>
      MULTI_ACTION_INPUTS.map(
        (inputName) => multiAction[inputName].keycode,
      ),
    ),
  ];
  for (const keycode of referencedKeycodes) {
    assert(
      !DEVICE_ACTION_REF.test(keycode),
      `Portable layer packs must use KA_<id>, not ${keycode}`,
    );
    assert(
      !DEVICE_MULTI_ACTION_REF.test(keycode),
      `Portable layer packs must use KM_<id>, not ${keycode}`,
    );
    const match = PORTABLE_ACTION_REF.exec(keycode);
    if (match) {
      assert(
        actionIds.has(Number(match[1])),
        `Layer pack references missing action ${keycode}`,
      );
    }
    const multiActionMatch = PORTABLE_MULTI_ACTION_REF.exec(keycode);
    if (multiActionMatch) {
      assert(
        multiActionIds.has(Number(multiActionMatch[1])),
        `Layer pack references missing multiaction ${keycode}`,
      );
    }
  }
  return true;
}

export function validateInputKeymap(keymap) {
  assert(
    keymap && typeof keymap === "object",
    "Input keymap must be an object",
  );
  assert(keymap.version === 1, "Unsupported Input keymap version; expected 1");
  assert(
    Array.isArray(keymap.profiles) && keymap.profiles.length > 0,
    "Input keymap has no profiles",
  );

  for (const profile of keymap.profiles) {
    assert(
      Array.isArray(profile.layers) && profile.layers.length > 0,
      `Profile ${profile.id} has no layers`,
    );
    validateLayer(profile.layers[0], `Profile ${profile.id} Layer 1`);
  }
  return true;
}

function getProfile(keymap, profileId) {
  const profile = keymap.profiles.find(
    (candidate) => candidate.id === profileId,
  );
  assert(profile, `Profile ${profileId} was not found`);
  return profile;
}

function blankLayer(id) {
  return {
    id,
    name: `Layer ${id + 1}`,
    color: 16711680,
    layout: {
      keymap: MATRIX_WIDTHS.map((width) =>
        Array.from({ length: width }, () => "KC_NONE"),
      ),
      encoders: [["KC_NONE", "KC_NONE", "KC_NONE"]],
      joystick: { type: "RADIAL", sectors: [] },
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

function nextId(items) {
  return items.reduce((highest, item) => Math.max(highest, item.id), -1) + 1;
}

// The firmware addresses macros by a small slot number, so ids cannot simply
// climb past the previous install's high-water mark: reinstalling would walk
// them out of the device's range and every macro key would go dead while plain
// keycodes kept working. Hand out the lowest free slots instead.
function freeIds(items, count) {
  const taken = new Set(items.map((item) => item.id));
  const ids = [];
  for (let id = 0; ids.length < count; id += 1) {
    if (!taken.has(id)) ids.push(id);
  }
  return ids;
}

function installPackAssets(keymap, layerPack, profile) {
  const sourceActions = layerPack.actions ?? [];
  const sourceMultiActions = layerPack.multiActions ?? [];
  if (sourceActions.length === 0 && sourceMultiActions.length === 0) {
    return clone(layerPack.layer);
  }

  keymap.macros ??= [];
  keymap.macrosGroups ??= [];
  keymap.multiActions ??= [];
  keymap.multiActionsGroups ??= [];

  const actionIds = freeIds(keymap.macros, sourceActions.length);
  const idMap = new Map(
    sourceActions.map((action, index) => [action.id, actionIds[index]]),
  );
  const multiActionIds = freeIds(
    keymap.multiActions,
    sourceMultiActions.length,
  );
  const multiActionIdMap = new Map(
    sourceMultiActions.map((multiAction, index) => [
      multiAction.id,
      multiActionIds[index],
    ]),
  );
  const mapPortableRef = (keycode) => {
    const actionMatch = PORTABLE_ACTION_REF.exec(keycode);
    if (actionMatch) return `KA_A${idMap.get(Number(actionMatch[1]))}`;
    const multiActionMatch = PORTABLE_MULTI_ACTION_REF.exec(keycode);
    if (multiActionMatch) {
      return `KA_M${multiActionIdMap.get(Number(multiActionMatch[1]))}`;
    }
    return keycode;
  };

  const installedActions = sourceActions.map((action) => ({
    id: idMap.get(action.id),
    name: action.name,
    color: action.color ?? null,
    icon: action.icon ?? null,
    actions: action.keyInputs.map((input) => ({
      kc: mapPortableRef(input.keycode),
      delay: input.delay,
      act: input.actionType,
    })),
  }));
  const installedIds = installedActions.map((action) => action.id);
  const installedMultiActions = sourceMultiActions.map((multiAction) => ({
    id: multiActionIdMap.get(multiAction.id),
    name: multiAction.name,
    color: multiAction.color ?? null,
    icon: multiAction.icon ?? null,
    kcOnTap: mapPortableRef(multiAction.tap.keycode),
    kcOnHold: mapPortableRef(multiAction.onHold.keycode),
    kcOnDoubleTap: mapPortableRef(multiAction.doubleTap.keycode),
    kcOnTapHold: mapPortableRef(multiAction.tapHold.keycode),
    tt: multiAction.tappingTerms,
  }));
  const installedMultiActionIds = installedMultiActions.map(
    (multiAction) => multiAction.id,
  );

  keymap.macros.push(...installedActions);
  if (installedIds.length > 0) {
    keymap.macrosGroups.push({
      id: nextId(keymap.macrosGroups),
      name: layerPack.name,
      tags: ["claude", "codex-micro"],
      color: layerPack.actionGroupColor ?? "#D97757",
      actionIds: installedIds,
    });
  }
  keymap.multiActions.push(...installedMultiActions);
  if (installedMultiActionIds.length > 0) {
    keymap.multiActionsGroups.push({
      id: nextId(keymap.multiActionsGroups),
      name: layerPack.name,
      tags: ["claude", "codex-micro", "double-tap"],
      color: layerPack.actionGroupColor ?? "#D97757",
      actionIds: installedMultiActionIds,
    });
  }
  profile.macrosUsed = [
    ...new Set([...(profile.macrosUsed ?? []), ...installedIds]),
  ].sort((a, b) => a - b);
  profile.multiActionsUsed = [
    ...new Set([
      ...(profile.multiActionsUsed ?? []),
      ...installedMultiActionIds,
    ]),
  ].sort((a, b) => a - b);

  return mapLayerKeycodes(layerPack.layer, mapPortableRef);
}

const PACK_GROUP_TAGS = ["claude", "codex-micro"];

function collectReferencedAssetIds(keymap) {
  const actionIds = new Set();
  const multiActionIds = new Set();
  const scan = (keycode) => {
    const actionMatch = DEVICE_ACTION_REF.exec(keycode);
    if (actionMatch) actionIds.add(Number(actionMatch[1]));
    const multiActionMatch = DEVICE_MULTI_ACTION_REF.exec(keycode);
    if (multiActionMatch) multiActionIds.add(Number(multiActionMatch[1]));
  };

  for (const profile of keymap.profiles) {
    for (const layer of profile.layers) {
      layerKeycodes(layer).forEach(scan);
    }
  }
  for (const multiAction of keymap.multiActions ?? []) {
    if (!multiActionIds.has(multiAction.id)) continue;
    for (const key of ["kcOnTap", "kcOnHold", "kcOnDoubleTap", "kcOnTapHold"]) {
      scan(multiAction[key]);
    }
  }
  for (const macro of keymap.macros ?? []) {
    if (!actionIds.has(macro.id)) continue;
    for (const input of macro.actions ?? []) scan(input.kc);
  }
  return { actionIds, multiActionIds };
}

// Repeated installs used to append a fresh copy of the pack's actions each
// time, leaving orphaned duplicates in Input's library. Remove pack-tagged
// assets that no layer references anymore; assets the user created outside
// this pack's groups are never touched.
function removeOrphanedPackAssets(keymap) {
  const { actionIds, multiActionIds } = collectReferencedAssetIds(keymap);
  const isPackGroup = (group) =>
    PACK_GROUP_TAGS.every((tag) => group.tags?.includes(tag));

  const packActionIds = new Set(
    (keymap.macrosGroups ?? [])
      .filter(isPackGroup)
      .flatMap((group) => group.actionIds ?? []),
  );
  const packMultiActionIds = new Set(
    (keymap.multiActionsGroups ?? [])
      .filter(isPackGroup)
      .flatMap((group) => group.actionIds ?? []),
  );

  keymap.macros = (keymap.macros ?? []).filter(
    (macro) => actionIds.has(macro.id) || !packActionIds.has(macro.id),
  );
  keymap.multiActions = (keymap.multiActions ?? []).filter(
    (multiAction) =>
      multiActionIds.has(multiAction.id) ||
      !packMultiActionIds.has(multiAction.id),
  );

  const keptActionIds = new Set(keymap.macros.map((macro) => macro.id));
  const keptMultiActionIds = new Set(
    keymap.multiActions.map((multiAction) => multiAction.id),
  );
  keymap.macrosGroups = (keymap.macrosGroups ?? [])
    .map((group) =>
      isPackGroup(group)
        ? {
            ...group,
            actionIds: (group.actionIds ?? []).filter((id) =>
              keptActionIds.has(id),
            ),
          }
        : group,
    )
    .filter((group) => !isPackGroup(group) || group.actionIds.length > 0);
  keymap.multiActionsGroups = (keymap.multiActionsGroups ?? [])
    .map((group) =>
      isPackGroup(group)
        ? {
            ...group,
            actionIds: (group.actionIds ?? []).filter((id) =>
              keptMultiActionIds.has(id),
            ),
          }
        : group,
    )
    .filter((group) => !isPackGroup(group) || group.actionIds.length > 0);

  for (const profile of keymap.profiles) {
    if (profile.macrosUsed) {
      profile.macrosUsed = profile.macrosUsed.filter((id) =>
        keptActionIds.has(id),
      );
    }
    if (profile.multiActionsUsed) {
      profile.multiActionsUsed = profile.multiActionsUsed.filter((id) =>
        keptMultiActionIds.has(id),
      );
    }
  }
}

function ensureLinkedApp(keymap, linkedApp) {
  const apps = keymap.linkedApps ?? [];
  const existing = apps.find((app) =>
    linkedApp.process?.trim()
      ? app.process === linkedApp.process
      : app.path === linkedApp.path,
  );
  if (existing) {
    keymap.linkedApps = apps.map((app) =>
      app.id === existing.id
        ? {
            ...app,
            name: linkedApp.name ?? app.name,
            process: linkedApp.process ?? app.process,
            path: linkedApp.path ?? app.path,
          }
        : app,
    );
    return existing.id;
  }

  const id = apps.reduce((max, app) => Math.max(max, app.id + 1), 0);
  keymap.linkedApps = [
    ...apps,
    {
      id,
      name: linkedApp.name ?? "",
      process: linkedApp.process ?? "",
      path: linkedApp.path ?? "",
    },
  ];
  return id;
}

export function applyLayerPack(
  keymap,
  layerPack,
  { layerNumber, profileId = 0 },
) {
  validateInputKeymap(keymap);
  validateLayerPack(layerPack);
  assert(Number.isInteger(layerNumber), "Layer number must be an integer");
  assert(
    layerNumber >= 2 && layerNumber <= MAX_LAYER,
    "Layer number must be between 2 and 6",
  );

  const updatedKeymap = clone(keymap);
  const sourceProfile = getProfile(keymap, profileId);
  const targetProfile = getProfile(updatedKeymap, profileId);
  const protectedLayer = JSON.stringify(sourceProfile.layers[0]);
  const targetIndex = layerNumber - 1;

  while (targetProfile.layers.length <= targetIndex) {
    targetProfile.layers.push(blankLayer(targetProfile.layers.length));
  }

  const existingLinkedAppId = targetProfile.layers[targetIndex]?.linkedAppId;
  // Retire the previous install's assets before allocating new IDs, so a
  // reinstall reclaims the same slots instead of climbing past them.
  targetProfile.layers[targetIndex] = blankLayer(targetIndex);
  removeOrphanedPackAssets(updatedKeymap);

  targetProfile.layers[targetIndex] = {
    ...installPackAssets(updatedKeymap, layerPack, targetProfile),
    id: targetIndex,
  };
  if (layerPack.linkedApp) {
    targetProfile.layers[targetIndex].linkedAppId = ensureLinkedApp(
      updatedKeymap,
      layerPack.linkedApp,
    );
  } else if (existingLinkedAppId !== undefined) {
    // Packs without a link keep whatever link the machine already had.
    targetProfile.layers[targetIndex].linkedAppId = existingLinkedAppId;
  }

  removeOrphanedPackAssets(updatedKeymap);

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
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}`,
  );
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
  const [keymap, layerPack] = await Promise.all([
    loadJson(keymapPath),
    loadJson(layerPackPath),
  ]);
  const updatedKeymap = applyLayerPack(keymap, layerPack, {
    layerNumber,
    profileId,
  });

  if (dryRun) {
    return { dryRun: true, layerName: layerPack.name, layerNumber };
  }

  const backupPath = `${keymapPath}.backup-${timestamp()}`;
  await copyFile(keymapPath, backupPath, constants.COPYFILE_EXCL);
  await writeJsonAtomic(keymapPath, updatedKeymap);
  return { dryRun: false, backupPath, layerName: layerPack.name, layerNumber };
}

export function createLayerPackFromKeymap(
  keymap,
  { layerNumber, profileId = 0 },
) {
  validateInputKeymap(keymap);
  assert(Number.isInteger(layerNumber), "Layer number must be an integer");
  assert(
    layerNumber >= 2 && layerNumber <= MAX_LAYER,
    "Layer number must be between 2 and 6",
  );

  const profile = getProfile(keymap, profileId);
  const layer = profile.layers[layerNumber - 1];
  assert(layer, `Layer ${layerNumber} was not found in profile ${profileId}`);

  const macrosById = new Map(
    (keymap.macros ?? []).map((macro) => [macro.id, macro]),
  );
  const multiActionsById = new Map(
    (keymap.multiActions ?? []).map((multiAction) => [
      multiAction.id,
      multiAction,
    ]),
  );
  const referencedActionIds = new Set();
  const referencedMultiActionIds = new Set();
  const pendingActionIds = [];
  const pendingMultiActionIds = [];
  const collectDeviceRef = (keycode) => {
    const actionMatch = DEVICE_ACTION_REF.exec(keycode);
    if (actionMatch) {
      const id = Number(actionMatch[1]);
      if (!referencedActionIds.has(id)) {
        referencedActionIds.add(id);
        pendingActionIds.push(id);
      }
    }
    const multiActionMatch = DEVICE_MULTI_ACTION_REF.exec(keycode);
    if (multiActionMatch) {
      const id = Number(multiActionMatch[1]);
      if (!referencedMultiActionIds.has(id)) {
        referencedMultiActionIds.add(id);
        pendingMultiActionIds.push(id);
      }
    }
  };
  layerKeycodes(layer).forEach(collectDeviceRef);

  let actionIndex = 0;
  let multiActionIndex = 0;
  while (
    actionIndex < pendingActionIds.length ||
    multiActionIndex < pendingMultiActionIds.length
  ) {
    if (multiActionIndex < pendingMultiActionIds.length) {
      const id = pendingMultiActionIds[multiActionIndex];
      multiActionIndex += 1;
      const multiAction = multiActionsById.get(id);
      assert(
        multiAction,
        `Layer ${layerNumber} references missing multiaction KA_M${id}`,
      );
      for (const key of [
        "kcOnTap",
        "kcOnHold",
        "kcOnDoubleTap",
        "kcOnTapHold",
      ]) {
        collectDeviceRef(multiAction[key]);
      }
    }

    if (actionIndex < pendingActionIds.length) {
      const id = pendingActionIds[actionIndex];
      actionIndex += 1;
      const macro = macrosById.get(id);
      assert(
        macro,
        `Layer ${layerNumber} references missing action KA_A${id}`,
      );
      for (const input of macro.actions ?? []) {
        collectDeviceRef(input.kc);
      }
    }
  }

  const actionIdMap = new Map(
    [...referencedActionIds]
      .sort((a, b) => a - b)
      .map((id, index) => [id, index]),
  );
  const multiActionIdMap = new Map(
    [...referencedMultiActionIds]
      .sort((a, b) => a - b)
      .map((id, index) => [id, index]),
  );
  const mapDeviceRef = (keycode) => {
    const actionMatch = DEVICE_ACTION_REF.exec(keycode);
    if (actionMatch) {
      return `KA_${actionIdMap.get(Number(actionMatch[1]))}`;
    }
    const multiActionMatch = DEVICE_MULTI_ACTION_REF.exec(keycode);
    if (multiActionMatch) {
      return `KM_${multiActionIdMap.get(Number(multiActionMatch[1]))}`;
    }
    return keycode;
  };
  const portableLayer = mapLayerKeycodes(layer, mapDeviceRef);
  delete portableLayer.id;
  const linkedAppEntry = (keymap.linkedApps ?? []).find(
    (app) => app.id === portableLayer.linkedAppId,
  );
  delete portableLayer.linkedAppId;
  const linkedApp = linkedAppEntry
    ? {
        name: linkedAppEntry.name ?? "",
        process: linkedAppEntry.process ?? "",
        path: linkedAppEntry.path ?? "",
      }
    : undefined;

  const actions = [...actionIdMap].map(([deviceId, portableId]) => {
    const macro = macrosById.get(deviceId);
    return {
      id: portableId,
      name: macro.name,
      color: macro.color ?? null,
      icon: macro.icon ?? null,
      keyInputs: (macro.actions ?? []).map((input) => ({
        keycode: mapDeviceRef(input.kc),
        delay: input.delay,
        actionType: input.act,
      })),
    };
  });
  const multiActions = [...multiActionIdMap].map(
    ([deviceId, portableId]) => {
      const multiAction = multiActionsById.get(deviceId);
      const portableInput = (keycode) => ({
        keycode: mapDeviceRef(keycode),
        delay: 0,
        actionType: 1,
      });
      return {
        id: portableId,
        name: multiAction.name,
        color: multiAction.color ?? null,
        icon: multiAction.icon ?? null,
        tap: portableInput(multiAction.kcOnTap),
        onHold: portableInput(multiAction.kcOnHold),
        doubleTap: portableInput(multiAction.kcOnDoubleTap),
        tapHold: portableInput(multiAction.kcOnTapHold),
        tappingTerms: multiAction.tt,
      };
    },
  );

  return {
    formatVersion: 1,
    device: "codex_micro",
    name: portableLayer.name,
    description: `Exported from Input profile ${profileId}, layer ${layerNumber}.`,
    ...(linkedApp ? { linkedApp } : {}),
    layer: portableLayer,
    actions,
    multiActions,
  };
}

export async function exportLayer({
  keymapPath,
  outputPath,
  layerNumber,
  profileId = 0,
}) {
  const keymap = await loadJson(keymapPath);
  const layerPack = createLayerPackFromKeymap(keymap, {
    layerNumber,
    profileId,
  });
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
