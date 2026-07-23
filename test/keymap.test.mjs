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
    "KA_M0",
    "KA_A1",
  ]);
  assert.deepEqual(updated.profiles[0].layers[1].layout.keymap[3], [
    "KA_A13",
    "KA_A14",
    "KA_A15",
  ]);
  assert.equal(updated.macros.length, 17);
  assert.equal(updated.macros[0].name, "Recent Task 1");
  assert.equal(updated.macros[0].icon, "icon-message-fas");
  assert.equal(
    updated.macros.every((macro) => macro.icon?.startsWith("icon-")),
    true,
  );
  assert.deepEqual(
    updated.macros[0].actions.map((input) => input.kc),
    [
      "KC_LCTL",
      "KC_LALT",
      "KC_LGUI",
      "KC_1",
      "KC_LGUI",
      "KC_LALT",
      "KC_LCTL",
    ],
  );
  assert.deepEqual(
    updated.macros.slice(0, 10).map((macro) => macro.name),
    [
      "Recent Task 1",
      "Recent Task 2",
      "Recent Task 3",
      "Recent Task 4",
      "Recent Task 5",
      "Recent Task 6",
      "Toggle Fast Mode",
      "Confirm Current Request",
      "Cancel Current Request",
      "Fork Current Task",
    ],
  );
  assert.deepEqual(
    updated.macros.slice(13, 16).map((macro) => macro.name),
    ["Voice Input Left", "Voice Input Right", "Send Message"],
  );
  assert.deepEqual(
    updated.macros.slice(13, 15).map((macro) => macro.actions),
    Array.from({ length: 2 }, () => [
      { kc: "KC_LGUI", delay: 0, act: 1 },
      { kc: "KC_D", delay: 0, act: 1 },
      { kc: "KC_D", delay: 0, act: 0 },
      { kc: "KC_LGUI", delay: 0, act: 0 },
    ]),
    "voice keys hold Command across an explicit D press and release",
  );
  assert.equal(
    updated.macros[15].actions.find((input) => input.act === 2).kc,
    "KC_ENTER",
  );
  assert.deepEqual(
    updated.profiles[0].macrosUsed,
    Array.from({ length: 17 }, (_, index) => index),
  );
  assert.equal(updated.multiActions.length, 1);
  assert.equal(updated.multiActions[0].kcOnTap, "KA_A0");
  assert.equal(updated.multiActions[0].kcOnDoubleTap, "KA_A16");
  assert.equal(updated.multiActions[0].tt, 250);
  assert.deepEqual(updated.profiles[0].multiActionsUsed, [0]);
  assert.equal(
    keymap.profiles[0].layers.length,
    1,
    "source keymap must not be mutated",
  );
  assert.equal(keymap.macros.length, 0, "source actions must not be mutated");
});

test("installing actions allocates IDs after existing Input macros", async () => {
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

  assert.deepEqual(updated.profiles[0].layers[1].layout.keymap[0], [
    "KA_M0",
    "KA_A7",
  ]);
  assert.equal(updated.macros[1].id, 6);
  assert.deepEqual(
    updated.profiles[0].macrosUsed,
    Array.from({ length: 18 }, (_, index) => index + 5),
  );
});

test("installing a multiaction allocates an unused Input ID", async () => {
  const keymap = fixtureKeymap();
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
  const layerPack = await loadJson(exampleLayerPath);

  const updated = applyLayerPack(keymap, layerPack, { layerNumber: 2 });

  assert.equal(updated.profiles[0].layers[1].layout.keymap[0][0], "KA_M5");
  assert.equal(updated.multiActions[1].id, 5);
  assert.deepEqual(updated.profiles[0].multiActionsUsed, [4, 5]);
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
  assert.equal(installed.macros.length, 17);
  assert.equal(installed.multiActions.length, 1);
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
  assert.deepEqual(exported.layer.layout.keymap[0], ["KM_0", "KA_1"]);
  assert.equal(exported.actions.length, 17);
  assert.equal(exported.actions[0].name, "Recent Task 1");
  assert.equal(exported.actions[0].icon, "icon-message-fas");
  assert.equal(exported.actions.every((action) => action.icon), true);
  assert.deepEqual(
    exported.actions[0].keyInputs.map((input) => input.keycode),
    [
      "KC_LCTL",
      "KC_LALT",
      "KC_LGUI",
      "KC_1",
      "KC_LGUI",
      "KC_LALT",
      "KC_LCTL",
    ],
  );
  assert.equal(exported.multiActions.length, 1);
  assert.equal(exported.multiActions[0].tap.keycode, "KA_0");
  assert.equal(exported.multiActions[0].doubleTap.keycode, "KA_16");
  assert.equal(exported.multiActions[0].tappingTerms, 250);
});

test("validation rejects an action reference that is not included", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  layerPack.actions = layerPack.actions.filter((action) => action.id !== 0);

  assert.throws(
    () => validateLayerPack(layerPack),
    /references missing action KA_0/,
  );
});

test("validation rejects a multiaction reference that is not included", async () => {
  const layerPack = await loadJson(exampleLayerPath);
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

test("reinstalling a layer keeps its Input app link", async () => {
  const keymap = fixtureKeymap();
  const layerPack = await loadJson(exampleLayerPath);
  const first = applyLayerPack(keymap, layerPack, { layerNumber: 2 });
  first.linkedApps = [{ id: 3, name: "Claude", path: "/Applications/Claude.app" }];
  first.profiles[0].layers[1].linkedAppId = 3;

  const updated = applyLayerPack(first, layerPack, { layerNumber: 2 });

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
  assert.equal(packMacros.length, 17, "old pack generations must be removed");
  assert.equal(
    keymap.macros.some((m) => m.name === "User macro"),
    true,
    "user macros outside the pack groups must be kept",
  );
  assert.equal(keymap.multiActions.length, 1);
  assert.equal(keymap.macrosGroups.length, 1);
  assert.equal(keymap.multiActionsGroups.length, 1);
  const names = new Set(packMacros.map((m) => m.name));
  assert.equal(names.size, 17, "no duplicate action names");
});
