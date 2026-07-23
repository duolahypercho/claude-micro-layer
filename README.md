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
- `sync` writes only `keymap.json` and verifies its device checksum; it does not
  flash firmware.

## Requirements

- Node.js 20 or newer
- Xcode Command Line Tools (`swiftc`) for the optional macOS focus helper
- Work Louder Input with a Codex Micro detected at least once
- macOS for hardware sync; Windows and Linux keymap detection still need
  community verification

## Quick start

For the complete walkthrough, recovery steps, and troubleshooting, see the
**[step-by-step setup guide](./SETUP.md)**.

Clone the repository and verify the included layer:

```sh
npm test
npm run validate
```

Install the background helper that focuses Claude when the top-left key is
double-tapped:

```sh
node ./bin/claude-micro-layer.mjs focus-helper install
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

With Input still closed, sync the verified keymap to the Codex Micro:

```sh
node ./bin/claude-micro-layer.mjs sync
```

The sync command verifies the checksum reported by the keyboard and reopens
Input normally when it finishes.

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

Every control has an icon from the SVG icon library bundled with Work Louder
Input. Descriptive action names remain available in Input for tooltips and
editing, while the keyboard preview uses the icons.

| Control group       | Mapping                          |
| ------------------- | -------------------------------- |
| First six keys      | Claude recent tasks 1–6          |
| Second four-key row | Fast mode, Confirm, Cancel, Fork |
| Bottom three keys   | Voice input, Voice input, Send   |
| Dial                | Zoom out, zoom in, actual size   |

The first six keys select the first six tasks shown in Claude's **Recents**
list. The top-left key is a native Input multiaction: a single tap selects
recent task 1; a double tap within 250 ms sends a private global shortcut to
the included macOS helper, which brings Claude to the front or launches it.
All single-tap task controls work while Claude remains in the background.

The helper uses macOS Accessibility to press Claude's visible controls. The
first task-control press may show a macOS permission prompt. Grant the installed
`claude-micro-focus` helper access under **System Settings → Privacy & Security
→ Accessibility**.

## Live status lights

The helper can mirror Claude chat status on the six task keys using the
keyboard's per-key task lighting. Enable it with:

```sh
node ./bin/claude-micro-layer.mjs lights on
```

| Chat status                  | Key light         |
| ---------------------------- | ----------------- |
| Finished, result unread      | Green, blinking   |
| Working or awaiting approval | Orange, blinking  |
| Idle                         | Orange, steady    |
| Error                        | Red, blinking     |
| Empty slot                   | Off               |

Status lights are volatile device state sent over the keyboard's vendor
RPC channel; the keymap file and the protected Codex Layer 1 configuration
are never written. The firmware renders the per-key task lights only while
**Layer 1** is selected, so Layer 1 doubles as the ambient Claude status
board: the helper also listens to Layer 1's own task-key events and selects
the matching recent chat, with Claude in the background. Lights are cleared
when lighting is disabled or the helper exits, and turned off when Claude is
not running. The first time lights are enabled, macOS asks once for **Input
Monitoring** access for `claude-micro-focus`.

Because the firmware exposes one shared set of six task lights and Layer 1
key events, avoid running Claude status lights while the Codex app is
actively driving the keyboard; the two would overwrite each other. Disable
with `node ./bin/claude-micro-layer.mjs lights off`.

A wired USB connection is strongly recommended: over Bluetooth the idle
keyboard sleeps its link, so lights can lag by a minute or more and keymap
syncs become unreliable. Over USB both are effectively instant.

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

Optional `multiActions` use Input's tap, hold, double-tap, and tap-hold fields.
Portable multiaction references use `KM_<id>` and are installed as device-side
`KA_M<id>` references.

Action icons use Input's bundled SVG-library codes, such as
`icon-folder-open-fas`. Keeping the library code in the JSON instead of copying
SVG markup lets Input render the icon at the correct size and color.

## Compatibility

The initial implementation was verified against:

- Codex Micro firmware `0.4.1`
- Work Louder Input `0.17.2`
- Input keymap format version `1`
- Claude Desktop for macOS `1.24012.1`

Always run `--dry-run` after upgrading Input or device firmware.

A separate Codex Micro PDF manual was not listed on Work Louder's site when
this guide was updated. Its official
[Creator Micro 2 product guide](https://worklouder.cc/creator-micro-2) documents
the hardware, six layers, Input integration, dial, joystick, and Codex
controls. This repository's [setup guide](./SETUP.md) is the practical manual
for the Claude Layer 2 configuration.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports should include the Input
version, firmware version, operating system, dry-run output, and a sanitized
layer pack. Never attach your entire Application Support directory.

## License

[MIT](./LICENSE)
