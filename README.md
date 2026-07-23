# Claude Micro Layer

Open-source, shareable layers for the **Codex Micro** hardware, starting with a
Claude Desktop layout for macOS.

This project avoids repeated manual setup in Work Louder Input. Layer packs are
plain JSON files that can be reviewed in Git, shared on GitHub, installed into
layers 2–6, and exported again after customization.

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with or
> supported by Anthropic, OpenAI, or Work Louder. Work Louder Input's file
> format is undocumented and may change.

## Safety model

- Codex-controlled Layer 1 is never modified.
- Only layers 2–6 can be installed.
- Every real installation creates a timestamped backup first.
- `--dry-run` validates without writing anything.
- The tool edits Input's local `keymap.json`; it does not flash firmware.

## Requirements

- Node.js 20 or newer
- Work Louder Input with a Codex Micro detected at least once
- macOS for the currently verified path detection; Windows and Linux paths are
  included but still need community verification

## Quick start

Clone the repository and verify the included layer:

```sh
npm test
npm run validate
```

Find the Input keymap on your computer:

```sh
node ./bin/claude-micro-layer.mjs detect
```

Close Work Louder Input, then perform a dry run:

```sh
node ./bin/claude-micro-layer.mjs install ./layers/claude-starter.json \
  --layer 2 \
  --dry-run
```

Install the layer after reviewing the dry-run result:

```sh
node ./bin/claude-micro-layer.mjs install ./layers/claude-starter.json \
  --layer 2
```

Open Input again to sync the updated keymap to the Codex Micro. After the
device has synced, Input does not need to stay open for normal keyboard use.

## Export your own layer

Configure a user layer in Input once, close Input, and export it:

```sh
node ./bin/claude-micro-layer.mjs export \
  --layer 2 \
  --output ./layers/my-claude-layer.json
```

Review the exported JSON before committing it. Layer packs should not contain
credentials or private application paths.

## Included Claude Desktop layout

The included pack carries its shortcut actions with it. The installer allocates
unused Input action IDs and rewrites the layer references, so it does not depend
on action numbers from the computer where the pack was created.

| Control group       | Mapping                                        |
| ------------------- | ---------------------------------------------- |
| Top two keys        | New Conversation (`⌘N`), Open File (`⌘O`)      |
| First four-key row  | Undo, Redo, Find, Reload                       |
| Second four-key row | Copy, Paste, Paste and Match Style, Select All |
| Bottom three keys   | Escape, Tab, Enter                             |
| Dial                | Zoom out, zoom in, actual size                 |

The Claude commands were checked against the installed Claude Desktop macOS
application. General editing commands continue to work in other applications,
so switch to this layer only when you want these controls.

## Layer-pack format

Layer packs use [`schema/layer.schema.json`](./schema/layer.schema.json). The
payload mirrors one Input layer but omits its numeric `id`; the installer assigns
the correct ID based on `--layer`. Optional `actions` use Input's readable action
shape (`keyInputs` with `keycode`, `delay`, and `actionType`). Portable layer
references use `KA_<id>`; installation converts them to Input's device-side
`KA_A<id>` references after resolving collisions.

## Compatibility

The initial implementation was verified against:

- Codex Micro firmware `3`
- Work Louder Input `0.17.2`
- Input keymap format version `1`
- Claude Desktop for macOS `1.24012.1`

Always run `--dry-run` after upgrading Input or device firmware.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports should include the Input
version, firmware version, operating system, dry-run output, and a sanitized
layer pack. Never attach your entire Application Support directory.

## License

[MIT](./LICENSE)
