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
    "KA_A0",
    "KA_A1",
  ]);
  assert.deepEqual(updated.profiles[0].layers[1].layout.keymap[3], [
    "KC_ESC",
    "KC_TAB",
    "KC_ENTER",
  ]);
  assert.equal(updated.macros.length, 13);
  assert.equal(updated.macros[0].name, "New Conversation");
  assert.deepEqual(
    updated.macros[0].actions.map((input) => input.kc),
    ["KC_LGUI", "KC_N", "KC_LGUI"],
  );
  assert.deepEqual(
    updated.profiles[0].macrosUsed,
    Array.from({ length: 13 }, (_, index) => index),
  );
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
    "KA_A6",
    "KA_A7",
  ]);
  assert.equal(updated.macros[1].id, 6);
  assert.deepEqual(
    updated.profiles[0].macrosUsed,
    Array.from({ length: 14 }, (_, index) => index + 5),
  );
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
  assert.equal(installed.macros.length, 13);
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
  assert.deepEqual(exported.layer.layout.keymap[0], ["KA_0", "KA_1"]);
  assert.equal(exported.actions.length, 13);
  assert.equal(exported.actions[0].name, "New Conversation");
  assert.deepEqual(
    exported.actions[0].keyInputs.map((input) => input.keycode),
    ["KC_LGUI", "KC_N", "KC_LGUI"],
  );
});

test("validation rejects an action reference that is not included", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  layerPack.actions = layerPack.actions.filter((action) => action.id !== 0);

  assert.throws(
    () => validateLayerPack(layerPack),
    /references missing action KA_0/,
  );
});
