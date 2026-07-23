# Claude Micro Layer

Open-source, shareable layers for the **Codex Micro** hardware, starting with a
Claude-friendly prompt-editing layout.

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

## Included starter layout

The first layer intentionally uses conservative, portable keycodes:

| Control group | Mapping |
| --- | --- |
| Top two keys | Escape, Enter |
| First four-key row | 1, 2, 3, 4 |
| Second four-key row | Left, Down, Up, Right |
| Bottom three keys | Tab, Space, Backspace |
| Dial | Volume down, volume up, mute |

The starter avoids guessing application-specific Claude shortcuts. Community
layers can add macros and richer workflows once their behavior has been tested
against a documented Input release.

## Layer-pack format

Layer packs use [`schema/layer.schema.json`](./schema/layer.schema.json). The
payload mirrors one Input layer but omits its numeric `id`; the installer assigns
the correct ID based on `--layer`.

## Compatibility

The initial implementation was verified against:

- Codex Micro firmware `3`
- Work Louder Input `0.17.2`
- Input keymap format version `1`

Always run `--dry-run` after upgrading Input or device firmware.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports should include the Input
version, firmware version, operating system, dry-run output, and a sanitized
layer pack. Never attach your entire Application Support directory.

## License

[MIT](./LICENSE)
