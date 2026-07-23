# Claude Micro Layer setup guide

This guide installs the included Claude Desktop layout into **Layer 2** of a
Work Louder Codex Micro. Layer 1 remains controlled by Codex and is never
modified.

## Before you begin

You need:

- A Mac with Node.js 20 or newer
- Xcode Command Line Tools, including `/usr/bin/swiftc`
- Work Louder Input installed in `/Applications/input.app`
- A Codex Micro that has connected to Input at least once
- Claude Desktop for macOS

The verified combination is Work Louder Input 0.17.2, Codex Micro firmware
0.4.1, and Input keymap format 1.

The illuminated Bluetooth controls select Bluetooth channels. They do not
select keyboard layers, so do not press them during setup.

Work Louder's official hardware overview is the
[Creator Micro 2 product guide](https://worklouder.cc/creator-micro-2). A
separate Codex Micro PDF manual was not listed on Work Louder's site when this
guide was updated, so this document covers the Claude-specific installation.

## 1. Download the project

Open Terminal and run:

```sh
git clone https://github.com/duolahypercho/claude-micro-layer.git
cd claude-micro-layer
npm install
```

If you already cloned the project, enter its directory and update it:

```sh
cd /path/to/claude-micro-layer
git pull
npm install
```

## 2. Verify the project

Run the test suite and validate the included layer pack:

```sh
npm test
npm run validate
```

Both commands must finish successfully before continuing.

## 3. Install the Claude focus helper

Run:

```sh
node ./bin/claude-micro-layer.mjs focus-helper install
```

This compiles a small native helper, installs it in your user Application
Support directory, and starts it automatically at login. It listens only for
`Control-Option-Command-C`. When that shortcut arrives, it brings the existing
Claude window to the front or launches Claude if it is closed. It does not read
keystrokes, conversation contents, or Claude data.

You can test the helper immediately by placing another app in front and pressing
`Control-Option-Command-C` once.

## 4. Confirm the keyboard connection

1. Open Work Louder Input.
2. Wake the Codex Micro with a normal key or the dial.
3. Wait until Input displays **Codex Micro** instead of **No device found**.
4. Quit Input completely with `⌘Q`.

Input must be closed during the remaining commands. The sync command will
reopen it when finished.

## 5. Find the Input keymap

Run:

```sh
node ./bin/claude-micro-layer.mjs detect
```

Normally, one path is printed. If more than one keymap appears, pass the
correct path to later commands with `--keymap "/full/path/to/keymap.json"`.

## 6. Perform a dry run

The dry run checks the layer pack and confirms that Layer 1 will not be
modified:

```sh
node ./bin/claude-micro-layer.mjs install \
  ./layers/claude-starter.json \
  --layer 2 \
  --dry-run
```

Continue only when the command reports `Dry run passed`.

## 7. Install the Layer 2 configuration

Run:

```sh
node ./bin/claude-micro-layer.mjs install \
  ./layers/claude-starter.json \
  --layer 2
```

The installer:

- Preserves the protected Layer 1
- Allocates action IDs without overwriting existing actions
- Adds the Claude Desktop layout to Layer 2
- Creates a timestamped `keymap.json.backup-...` file before writing

Keep the printed backup path until the keyboard has been tested.

## 8. Sync the configuration to the keyboard

Make sure Input is still closed, then run:

```sh
node ./bin/claude-micro-layer.mjs sync
```

During sync, the tool temporarily starts Input with a localhost-only device
bridge, waits for the Codex Micro, writes `keymap.json`, and compares the
keyboard's reported checksum with the file it sent. It then closes the
temporary bridge and reopens Input normally.

Success looks similar to:

```text
Synced keymap to Codex Micro device 1.
Verified checksum: 8420807bbe69eb1fbbabc2e349619158150acc4d
Work Louder Input has been reopened normally.
```

The checksum will differ when the keymap contents differ. The important part
is that the command reports a verified checksum and exits successfully.

## 9. Confirm Layer 2 in Input

1. Wait for Input to show **Codex Micro**.
2. Open the **Keymap** tab.
3. Select the circle labelled **2** under Layers.
4. Confirm that the layer name is **Claude Desktop**.
5. Confirm that SVG icons appear on all keys and dial controls. Hover over or
   select an icon to see action names such as **New Conversation**, **Open
   File**, **Undo**, and **Redo**.

## 10. Test the Claude controls

Bring Claude Desktop to the front, select Layer 2 in Input, and test one control
at a time:

| Control group       | Actions                                        |
| ------------------- | ---------------------------------------------- |
| Top two keys        | New Conversation, Open File                    |
| First four-key row  | Undo, Redo, Find, Reload                       |
| Second four-key row | Copy, Paste, Paste and Match Style, Select All |
| Bottom three keys   | Escape, Tab, Enter                             |
| Dial                | Zoom out, zoom in, actual size                 |

New Conversation opens a new Claude conversation, so use it only when you are
ready to leave the current one.

The top-left key has two gestures:

- Single tap: New Conversation
- Double tap within 250 ms: bring Claude to the front

The single-tap action waits briefly for the 250 ms double-tap window to expire.

## Switching layers

The current release installs and syncs Layer 2, but it does not add a physical
layer-switch gesture to the Codex-controlled Layer 1. Select Layer 2 in Work
Louder Input when you want to use the Claude layout.

The white or blue LEDs are Bluetooth-channel indicators, not layer indicators.

## Restoring the backup

If the layout does not behave as expected:

1. Quit Work Louder Input with `⌘Q`.
2. Copy the exact backup printed during installation over `keymap.json`.
3. Run the sync command again.

Example using explicit paths:

```sh
cp "/full/path/keymap.json.backup-YYYY-MM-DD..." \
  "/full/path/keymap.json"
node ./bin/claude-micro-layer.mjs sync \
  --keymap "/full/path/keymap.json"
```

Do not use wildcards when choosing a backup. Confirm the exact timestamp first.

## Troubleshooting

### `Quit Work Louder Input before running sync`

Input is still running. Return to Input, press `⌘Q`, and run `sync` again.

### Timed out waiting for Codex Micro

Wake the keyboard with a normal key or turn the dial. Do not press a Bluetooth
channel control. If Input still cannot see it, reopen Input normally, wait for
the connection, quit Input, and retry `sync`.

### No keymap found

Open Input once with the Codex Micro connected. If detection still fails, pass
the path reported by `detect` explicitly with `--keymap`.

### Multiple keymaps found

Use `detect`, identify the directory for the Codex Micro you want, and pass its
full `keymap.json` path with `--keymap`.

### Custom Input installation path

Pass the application path explicitly:

```sh
node ./bin/claude-micro-layer.mjs sync \
  --input-app "/full/path/to/input.app"
```

### Double tap does not bring Claude forward

First press `Control-Option-Command-C` on the Mac keyboard. If Claude does not
come forward, reinstall and restart the helper:

```sh
node ./bin/claude-micro-layer.mjs focus-helper install
```

If the keyboard shortcut works but the double tap does not, reinstall the layer,
sync it again, and make sure both taps occur within 250 ms.
