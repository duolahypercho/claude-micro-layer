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

const exampleLayerPath = new URL("../layers/claude-starter.json", import.meta.url);

function fixtureKeymap() {
  return {
    version: 1,
    activeProfileId: 0,
    profiles: [
      {
        id: 0,
        name: "Default",
        layers: [
          {
            id: 0,
            name: "Layer 1",
            color: 16711680,
            layout: {
              keymap: [
                ["KV_OAI_AG00", "KV_OAI_AG01"],
                ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
                ["KV_OAI_ACT06", "KV_OAI_ACT07", "KV_OAI_ACT08", "KV_OAI_ACT09"],
                ["KV_OAI_ACT10", "KV_OAI_ACT11", "KV_OAI_ACT12"],
              ],
              encoders: [["KV_OAI_ENC_CC", "KV_OAI_ENC_CW", "KV_OAI_ENC_CLK"]],
              joystick: { type: "VENDOR", sectors: [] },
            },
          },
        ],
      },
    ],
    multiActions: [],
    macros: [],
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
  assert.equal(updated.profiles[0].layers[1].name, "Claude Starter");
  assert.deepEqual(updated.profiles[0].layers[1].layout.keymap[3], ["KC_TAB", "KC_SPACE", "KC_BSPC"]);
  assert.equal(keymap.profiles[0].layers.length, 1, "source keymap must not be mutated");
});

test("Layer 1 cannot be replaced", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  assert.throws(
    () => applyLayerPack(fixtureKeymap(), layerPack, { layerNumber: 1 }),
    /between 2 and 6/,
  );
});

test("install creates a backup and writes valid JSON", async () => {
  const temporaryDirectory = await mkdtemp(join(os.tmpdir(), "claude-micro-layer-"));
  const keymapPath = join(temporaryDirectory, "keymap.json");
  const layerPackPath = join(temporaryDirectory, "layer.json");
  await writeFile(keymapPath, `${JSON.stringify(fixtureKeymap(), null, 2)}\n`, "utf8");
  await writeFile(layerPackPath, await readFile(exampleLayerPath, "utf8"), "utf8");

  const result = await installLayer({ keymapPath, layerPackPath, layerNumber: 2 });
  const installed = JSON.parse(await readFile(keymapPath, "utf8"));
  const backup = JSON.parse(await readFile(result.backupPath, "utf8"));

  assert.equal(installed.profiles[0].layers[1].name, "Claude Starter");
  assert.equal(backup.profiles[0].layers.length, 1);
});

test("an installed layer exports as a portable pack", async () => {
  const layerPack = await loadJson(exampleLayerPath);
  const installed = applyLayerPack(fixtureKeymap(), layerPack, { layerNumber: 2 });
  const exported = createLayerPackFromKeymap(installed, { layerNumber: 2 });

  assert.equal(exported.formatVersion, 1);
  assert.equal(exported.device, "codex_micro");
  assert.equal(exported.layer.name, "Claude Starter");
  assert.equal("id" in exported.layer, false);
});
