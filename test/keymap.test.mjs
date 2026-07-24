import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyLayerPack,
  createLayerPackFromKeymap,
  installLayer,
  loadJson,
  validateLayerPack,
} from "../src/keymap.mjs";
import { verifyDeviceKeymap } from "../src/input-sync.mjs";

const exampleLayerPath = new URL(
  "../layers/claude-starter.json",
  import.meta.url,
);

function fixtureKeymap() {
  return {
    version: 1,
    activeProfileId: 0,
    profiles: [
      {
        id: 0,
        name: "Default",
        macrosUsed: [],
        multiActionsUsed: [],
        layers: [
          {
            id: 0,
            name: "Layer 1",
            color: 16711680,
            layout: {
              keymap: [
                ["KV_OAI_AG00", "KV_OAI_AG01"],
                ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
                [
                  "KV_OAI_ACT06",
                  "KV_OAI_ACT07",
                  "KV_OAI_ACT08",
                  "KV_OAI_ACT09",
                ],
                ["KV_OAI_ACT10", "KV_OAI_ACT11", "KV_OAI_ACT12"],
              ],
              encoders: [["KV_OAI_ENC_CC", "KV_OAI_ENC_CW", "KV_OAI_ENC_CLK"]],
              joystick: { type: "VENDOR", sectors: [] },
            },
          },
        ],
      },
    ],
    macros: [],
    macrosGroups: [],
    multiActions: [],
    multiActionsGroups: [],
    linkedApps: [],
  };
}

test("the included Claude layer is valid", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  assert.equal(validateLayerPack(layerPack), true);
});

test("installing Layer 2 preserves the protected Codex layer", async () => {
  const keymap = fixtureKeymap();
  const originalLayerOne = structuredClone(keymap.profiles[0].layers[0]);
  const layerPack = await loadJson(exampleLayerPath);

  const updated = applyLayerPack(keymap, layerPack, { layerNumber: 2 });

  assert.deepEqual(updated.profiles[0].layers[0], originalLayerOne);
  assert.equal(updated.profiles[0].layers[1].id, 1);
  assert.equal(updated.profiles[0].layers[1].name, "Claude Desktop");
  assert.deepEqual(updated.profiles[0].layers[1].layout.keymap[0], [
    "KV_OAI_AG00",
    "KV_OAI_AG01",
  ], "task keys stay vendor agent keys so the firmware lights them");
  assert.deepEqual(updated.profiles[0].layers[1].layout.keymap[3], [
    "KC_F18",
    "KC_F18",
    "KA_A7",
  ], "the voice keys are a held keycode, not a macro");
  assert.equal(updated.macros.length, 8);
  assert.equal(updated.macros[0].name, "Fast Mode");
  assert.equal(updated.macros[0].icon, "icon-bolt-lightning-fas");
  assert.equal(
    updated.macros.every((macro) => macro.icon?.startsWith("icon-")),
    true,
  );
  assert.deepEqual(
    updated.macros[0].actions.map((input) => input.kc),
    ["KC_SLSH", "KC_F", "KC_A", "KC_S", "KC_T", "KC_ENT", "KC_ENT"],
  );
  assert.deepEqual(
    updated.macros.map((macro) => macro.name),
    [
      "Fast Mode",
      "Confirm Current Request",
      "Cancel Current Request",
      "Fork Current Task",
      "Zoom Out",
      "Zoom In",
      "Actual Size",
      "Send Message",
    ],
  );
  assert.deepEqual(
    updated.profiles[0].macrosUsed,
    Array.from({ length: 8 }, (_, index) => index),
  );
  assert.equal(
    keymap.profiles[0].layers.length,
    1,
    "source keymap must not be mutated",
  );
  assert.equal(keymap.macros.length, 0, "source actions must not be mutated");
});

test("installing actions reuses the lowest free macro IDs", async () => {
  const keymap = fixtureKeymap();
  keymap.macros.push({
    id: 5,
    name: "Existing",
    color: null,
    icon: null,
    actions: [{ kc: "KC_A", delay: 0, act: 2 }],
  });
  keymap.profiles[0].macrosUsed.push(5);
  const layerPack = await loadJson(exampleLayerPath);

  const updated = applyLayerPack(keymap, layerPack, { layerNumber: 2 });

  assert.equal(updated.macros[1].id, 0, "installs fill the gap below id 5");
  assert.equal(
    Math.max(...updated.macros.map((macro) => macro.id)),
    8,
    "IDs stay in the firmware's low slot range",
  );
  assert.deepEqual(
    updated.profiles[0].macrosUsed,
    Array.from({ length: 9 }, (_, index) => index),
  );
});

// The firmware addresses macros by slot, so IDs that climb on every reinstall
// eventually leave its range and every macro key goes dead.
test("reinstalling does not push macro IDs higher each time", async () => {
  const layerPack = await loadJson(exampleLayerPath);

  let keymap = applyLayerPack(fixtureKeymap(), layerPack, { layerNumber: 2 });
  const firstIds = keymap.macros.map((macro) => macro.id);
  for (let round = 0; round < 5; round += 1) {
    keymap = applyLayerPack(keymap, layerPack, { layerNumber: 2 });
  }

  assert.deepEqual(keymap.macros.map((macro) => macro.id), firstIds);
});

test("installing a multiaction reuses the lowest free ID", async () => {
  const keymap = fixtureKeymap();
  const withMultiAction = (pack) => ({
    ...pack,
    layer: {
      ...pack.layer,
      layout: {
        ...pack.layer.layout,
        keymap: [["KM_0", ...pack.layer.layout.keymap[0].slice(1)],
          ...pack.layer.layout.keymap.slice(1)],
      },
    },
    multiActions: [
      {
        id: 0,
        name: "Send / New Chat",
        tap: { keycode: "KA_7", delay: 0, actionType: 2 },
        onHold: { keycode: "KC_NONE", delay: 0, actionType: 2 },
        doubleTap: { keycode: "KA_7", delay: 0, actionType: 2 },
        tapHold: { keycode: "KC_NONE", delay: 0, actionType: 2 },
        tappingTerms: 250,
      },
    ],
  });
  keymap.multiActions.push({
    id: 4,
    name: "Existing multiaction",
    color: null,
    icon: null,
    kcOnTap: "KC_A",
    kcOnHold: "KC_NONE",
    kcOnDoubleTap: "KC_B",
    kcOnTapHold: "KC_NONE",
    tt: 250,
  });
  keymap.profiles[0].multiActionsUsed.push(4);
  const layerPack = withMultiAction(await loadJson(exampleLayerPath));

  const updated = applyLayerPack(keymap, layerPack, { layerNumber: 2 });

  assert.equal(updated.profiles[0].layers[1].layout.keymap[0][0], "KA_M0");
  assert.equal(updated.multiActions[1].id, 0);
  assert.deepEqual(updated.profiles[0].multiActionsUsed, [0, 4]);
});

test("Layer 1 cannot be replaced", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  assert.throws(
    () => applyLayerPack(fixtureKeymap(), layerPack, { layerNumber: 1 }),
    /between 2 and 6/,
  );
});

test("install creates a backup and writes valid JSON", async () => {
  const temporaryDirectory = await mkdtemp(
    join(os.tmpdir(), "claude-micro-layer-"),
  );
  const keymapPath = join(temporaryDirectory, "keymap.json");
  const layerPackPath = join(temporaryDirectory, "layer.json");
  await writeFile(
    keymapPath,
    `${JSON.stringify(fixtureKeymap(), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    layerPackPath,
    await readFile(exampleLayerPath, "utf8"),
    "utf8",
  );

  const result = await installLayer({
    keymapPath,
    layerPackPath,
    layerNumber: 2,
  });
  const installed = JSON.parse(await readFile(keymapPath, "utf8"));
  const backup = JSON.parse(await readFile(result.backupPath, "utf8"));

  assert.equal(installed.profiles[0].layers[1].name, "Claude Desktop");
  assert.equal(installed.macros.length, 8);
  assert.equal(backup.profiles[0].layers.length, 1);
  assert.equal(backup.macros.length, 0);
});

test("an installed layer exports as a portable pack", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  const installed = applyLayerPack(fixtureKeymap(), layerPack, {
    layerNumber: 2,
  });
  const exported = createLayerPackFromKeymap(installed, { layerNumber: 2 });

  assert.equal(exported.formatVersion, 1);
  assert.equal(exported.device, "codex_micro");
  assert.equal(exported.layer.name, "Claude Desktop");
  assert.equal("id" in exported.layer, false);
  assert.deepEqual(exported.layer.layout.keymap[0], [
    "KV_OAI_AG00",
    "KV_OAI_AG01",
  ]);
  assert.equal(exported.actions.length, 8);
  assert.equal(exported.actions[0].name, "Fast Mode");
  assert.equal(exported.actions[0].icon, "icon-bolt-lightning-fas");
  assert.equal(exported.actions.every((action) => action.icon), true);
  assert.deepEqual(
    exported.actions[0].keyInputs.map((input) => input.keycode),
    ["KC_SLSH", "KC_F", "KC_A", "KC_S", "KC_T", "KC_ENT", "KC_ENT"],
  );
});

test("validation rejects an action reference that is not included", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  layerPack.actions = layerPack.actions.filter((action) => action.id !== 6);

  assert.throws(
    () => validateLayerPack(layerPack),
    /references missing action KA_6/,
  );
});

test("validation rejects a multiaction reference that is not included", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  const keymap = layerPack.layer.layout.keymap;
  keymap[0] = ["KM_0", ...keymap[0].slice(1)];
  layerPack.multiActions = [];

  assert.throws(
    () => validateLayerPack(layerPack),
    /references missing multiaction KM_0/,
  );
});

test("hardware sync accepts only the exact device checksum", () => {
  const files = [{ name: "keymap.json", size: 8443, checksum: "expected" }];

  assert.equal(verifyDeviceKeymap(files, "expected").size, 8443);
  assert.throws(
    () => verifyDeviceKeymap(files, "different"),
    /Device checksum mismatch/,
  );
});

test("a pack's app link installs into the keymap and stays stable", async () => {
  const layerPack = await loadJson(exampleLayerPath);

  const first = applyLayerPack(fixtureKeymap(), layerPack, { layerNumber: 2 });
  assert.equal(first.linkedApps.length, 1);
  assert.equal(first.linkedApps[0].process, layerPack.linkedApp.process);
  assert.equal(
    first.profiles[0].layers[1].linkedAppId,
    first.linkedApps[0].id,
  );

  const again = applyLayerPack(first, layerPack, { layerNumber: 2 });
  assert.deepEqual(again.linkedApps, first.linkedApps);
  assert.equal(
    again.profiles[0].layers[1].linkedAppId,
    first.linkedApps[0].id,
  );
});

test("reinstalling refreshes a stale app link's name and path", async () => {
  const layerPack = await loadJson(exampleLayerPath);

  const first = applyLayerPack(fixtureKeymap(), layerPack, { layerNumber: 2 });
  first.linkedApps = [
    { id: first.linkedApps[0].id, name: "Old", process: layerPack.linkedApp.process, path: "" },
  ];

  const updated = applyLayerPack(first, layerPack, { layerNumber: 2 });

  assert.equal(updated.linkedApps.length, 1);
  assert.equal(updated.linkedApps[0].name, layerPack.linkedApp.name);
  assert.equal(updated.linkedApps[0].path, layerPack.linkedApp.path);
  assert.equal(
    updated.profiles[0].layers[1].linkedAppId,
    updated.linkedApps[0].id,
  );
});

test("reinstalling a link-free pack keeps the machine's app link", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  const linkFreePack = structuredClone(layerPack);
  delete linkFreePack.linkedApp;

  const first = applyLayerPack(fixtureKeymap(), linkFreePack, {
    layerNumber: 2,
  });
  first.linkedApps = [
    { id: 3, name: "Claude", path: "/Applications/Claude.app" },
  ];
  first.profiles[0].layers[1].linkedAppId = 3;

  const updated = applyLayerPack(first, linkFreePack, { layerNumber: 2 });

  assert.equal(updated.profiles[0].layers[1].linkedAppId, 3);
  assert.deepEqual(updated.linkedApps, first.linkedApps);
});

test("reinstalling a pack does not accumulate duplicate actions", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  let keymap = applyLayerPack(fixtureKeymap(), layerPack, { layerNumber: 2 });
  keymap.macros.push({
    id: 500,
    name: "User macro",
    color: null,
    icon: null,
    actions: [{ kc: "KC_A", delay: 0, act: 2 }],
  });

  keymap = applyLayerPack(keymap, layerPack, { layerNumber: 2 });
  keymap = applyLayerPack(keymap, layerPack, { layerNumber: 2 });

  const packMacros = keymap.macros.filter((m) => m.name !== "User macro");
  assert.equal(packMacros.length, 8, "old pack generations must be removed");
  assert.equal(
    keymap.macros.some((m) => m.name === "User macro"),
    true,
    "user macros outside the pack groups must be kept",
  );
  assert.equal(keymap.macrosGroups.length, 1);
  const names = new Set(packMacros.map((m) => m.name));
  assert.equal(names.size, 8, "no duplicate action names");
});
