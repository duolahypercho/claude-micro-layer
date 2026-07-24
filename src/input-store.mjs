import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join } from "node:path";

// Work Louder Input keeps its own database (input_storage.json, a Loki store)
// separate from the device keymap.json this tool writes. Input's UI reads the
// database and can push it back to the keyboard, so a keymap sync that touches
// only the device file leaves Input showing — and re-syncing — a stale layer.
// After every sync we mirror the freshly written keymap into Input's database
// so the two never diverge.

export function inputStorePath(homeDirectory = os.homedir()) {
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "Input",
    "input_storage.json",
  );
}

// A device macro (kc/act) and an Input action (keycode/actionType) are the same
// key sequence in two dialects.
function actionFromMacro(macro) {
  return {
    id: macro.id,
    name: macro.name,
    color: macro.color ?? null,
    icon: macro.icon ?? null,
    keyInputs: (macro.actions ?? []).map((input) => ({
      keycode: input.kc,
      delay: input.delay ?? 0,
      actionType: input.act,
    })),
  };
}

function multiactionFromDevice(multiAction) {
  return {
    id: multiAction.id,
    name: multiAction.name,
    color: multiAction.color ?? null,
    icon: multiAction.icon ?? null,
    kcOnTap: multiAction.kcOnTap,
    kcOnHold: multiAction.kcOnHold,
    kcOnDoubleTap: multiAction.kcOnDoubleTap,
    kcOnTapHold: multiAction.kcOnTapHold,
    tt: multiAction.tt,
  };
}

function findDeviceCollectionIndex(store) {
  return (store.collections ?? []).findIndex(
    (collection) => collection?.name === "devices",
  );
}

function matchesDevice(row, deviceKeymap) {
  const target = deviceKeymap.device;
  if (!target || !row.device) return true;
  // Match on the vendor identifiers when present; fall back to accepting the
  // single row so a schema drift never blocks the update.
  const sameProduct =
    row.device.productId === undefined ||
    target.productId === undefined ||
    row.device.productId === target.productId;
  const sameVendor =
    row.device.vendorId === undefined ||
    target.vendorId === undefined ||
    row.device.vendorId === target.vendorId;
  return sameProduct && sameVendor;
}

// Return a new store with the matching device row's layers, actions, groups and
// app links replaced by the device keymap's. Loki bookkeeping and any fields
// this tool does not own (files, smartActions, meta) are preserved untouched.
export function applyKeymapToInputStore(store, deviceKeymap) {
  const collectionIndex = findDeviceCollectionIndex(store);
  if (collectionIndex === -1) {
    throw new Error("Input store has no devices collection");
  }
  const collection = store.collections[collectionIndex];
  const rows = collection.data ?? [];
  const matches = rows.filter((row) => matchesDevice(row, deviceKeymap));
  const targetRow = matches.length === 1 ? matches[0] : rows[0];
  if (!targetRow) {
    throw new Error("Input store has no device row to update");
  }

  const actions = (deviceKeymap.macros ?? []).map(actionFromMacro);
  const multiactions = (deviceKeymap.multiActions ?? []).map(
    multiactionFromDevice,
  );

  const nextRow = {
    ...targetRow,
    activeProfileId: deviceKeymap.activeProfileId ?? targetRow.activeProfileId,
    // Input tracks layers per profile; only the layer contents change, so keep
    // each profile's own fields and swap in the keymap's layers.
    profiles: (targetRow.profiles ?? []).map((profile, index) => {
      const source = deviceKeymap.profiles?.[index];
      if (!source) return profile;
      return { ...profile, name: source.name ?? profile.name, layers: source.layers };
    }),
    actions,
    actionGroups: deviceKeymap.macrosGroups ?? [],
    multiactions,
    multiactionGroups: deviceKeymap.multiActionsGroups ?? [],
    linkedApps: deviceKeymap.linkedApps ?? [],
  };

  const nextRows = rows.map((row) => (row === targetRow ? nextRow : row));
  const nextCollection = { ...collection, data: nextRows };
  const nextCollections = store.collections.map((collection, index) =>
    index === collectionIndex ? nextCollection : collection,
  );
  return { ...store, collections: nextCollections };
}

// Mirror a device keymap into Input's database. Missing store (a user who has
// never opened Input) is not an error: Input will build its database from the
// keyboard on first launch. Returns whether the store was written.
export async function updateInputStore(
  deviceKeymap,
  { homeDirectory = os.homedir(), storePath = inputStorePath(homeDirectory) } = {},
) {
  let contents;
  try {
    contents = await readFile(storePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { updated: false, storePath };
    throw new Error(`Unable to read ${storePath}: ${error.message}`);
  }

  const store = JSON.parse(contents);
  const nextStore = applyKeymapToInputStore(store, deviceKeymap);

  const backupPath = `${storePath}.backup-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  await copyFile(storePath, backupPath);

  const temporaryPath = join(
    dirname(storePath),
    `.${basename(storePath)}.tmp-${process.pid}`,
  );
  await writeFile(temporaryPath, JSON.stringify(nextStore), "utf8");
  await rename(temporaryPath, storePath);
  return { updated: true, storePath, backupPath };
}
