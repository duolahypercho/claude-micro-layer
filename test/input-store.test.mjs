import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyKeymapToInputStore,
  inputStorePath,
  updateInputStore,
} from "../src/input-store.mjs";

function fixtureStore() {
  return {
    collections: [
      { name: "app_settings", data: [{ theme: "dark", $loki: 1 }] },
      {
        name: "devices",
        maxId: 1,
        data: [
          {
            $loki: 1,
            meta: { revision: 3 },
            device: { productId: 33632, vendorId: 12346 },
            files: [{ name: "keymap.json" }],
            activeProfileId: 0,
            profiles: [
              {
                id: 0,
                name: "Default",
                layers: [
                  { id: 0, name: "Layer 1", layout: { keymap: [["KV_OAI_AG00"]] } },
                  { id: 1, name: "Old", layout: { keymap: [["KV_OAI_ACT06"]] } },
                ],
              },
            ],
            actions: [{ id: 9, name: "Stale", keyInputs: [] }],
            actionGroups: [{ id: 3, name: "Stale" }],
            multiactions: [],
            multiactionGroups: [],
            linkedApps: [],
            smartActions: [{ id: 0, name: "keep me" }],
          },
        ],
      },
    ],
  };
}

function deviceKeymap() {
  return {
    activeProfileId: 0,
    profiles: [
      {
        id: 0,
        name: "Default",
        macrosUsed: [0],
        layers: [
          { id: 0, name: "Layer 1", layout: { keymap: [["KV_OAI_AG00"]] } },
          {
            id: 1,
            name: "Claude Desktop",
            linkedAppId: 0,
            layout: { keymap: [["KA_A0"]] },
            lights: null,
          },
        ],
      },
    ],
    macros: [
      {
        id: 0,
        name: "Send Message",
        color: null,
        icon: "icon-paper-plane-fas",
        actions: [{ kc: "KC_ENT", delay: 0, act: 2 }],
      },
    ],
    macrosGroups: [
      { id: 0, name: "Claude Desktop", tags: ["claude"], actionIds: [0] },
    ],
    multiActions: [],
    multiActionsGroups: [],
    linkedApps: [
      { id: 0, name: "Claude", process: "com.anthropic.claudefordesktop", path: "" },
    ],
    device: { productId: 33632, vendorId: 12346 },
  };
}

test("the input store lives in Input's application support directory", () => {
  const path = inputStorePath("/Users/example");
  assert.equal(
    path,
    "/Users/example/Library/Application Support/Input/input_storage.json",
  );
});

test("applying a keymap mirrors layers, actions, and links into the store", () => {
  const updated = applyKeymapToInputStore(fixtureStore(), deviceKeymap());
  const row = updated.collections[1].data[0];

  assert.equal(row.profiles[0].layers[1].name, "Claude Desktop");
  assert.deepEqual(row.profiles[0].layers[1].layout.keymap, [["KA_A0"]]);
  assert.equal(row.actions.length, 1);
  assert.equal(row.actions[0].name, "Send Message");
  assert.deepEqual(
    row.actions[0].keyInputs,
    [{ keycode: "KC_ENT", delay: 0, actionType: 2 }],
    "device kc/act becomes Input keycode/actionType",
  );
  assert.equal(row.actionGroups[0].name, "Claude Desktop");
  assert.equal(row.linkedApps[0].process, "com.anthropic.claudefordesktop");
});

test("applying a keymap preserves fields the tool does not own", () => {
  const updated = applyKeymapToInputStore(fixtureStore(), deviceKeymap());
  const row = updated.collections[1].data[0];

  assert.equal(row.$loki, 1);
  assert.deepEqual(row.meta, { revision: 3 });
  assert.deepEqual(row.smartActions, [{ id: 0, name: "keep me" }]);
  assert.equal(updated.collections[0].name, "app_settings");
});

test("applying a keymap does not mutate the original store", () => {
  const store = fixtureStore();
  applyKeymapToInputStore(store, deviceKeymap());
  assert.equal(store.collections[1].data[0].profiles[0].layers[1].name, "Old");
});

test("a missing store is not an error", async () => {
  const result = await updateInputStore(deviceKeymap(), {
    storePath: join(os.tmpdir(), "does-not-exist-claude-micro", "store.json"),
  });
  assert.equal(result.updated, false);
});

test("updating the store writes a backup and valid JSON", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "claude-micro-store-"));
  const storePath = join(directory, "input_storage.json");
  await writeFile(storePath, JSON.stringify(fixtureStore()), "utf8");

  const result = await updateInputStore(deviceKeymap(), { storePath });
  assert.equal(result.updated, true);

  const written = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(
    written.collections[1].data[0].profiles[0].layers[1].name,
    "Claude Desktop",
  );
  const backup = JSON.parse(await readFile(result.backupPath, "utf8"));
  assert.equal(backup.collections[1].data[0].profiles[0].layers[1].name, "Old");
});
