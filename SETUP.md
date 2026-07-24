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
the private `Control-Option-Command` shortcuts emitted by this Layer 2 pack.
The helper drives the requested Claude control without bringing Claude
forward. Switching chats is the exception: Claude does that with its own
Command-digit shortcut, which it ignores unless it is frontmost.

The helper uses macOS Accessibility to find Claude's visible controls. The
first time you use a task key, macOS may ask for access. Open **System Settings
→ Privacy & Security → Accessibility** and enable `claude-micro-focus`. It does
not read keystrokes or conversation text.

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
5. The first six keys show the firmware's own agent keys — they are drawn by
   the keyboard, not by this pack, which is what lets them carry chat status
   colors. The remaining keys show SVG icons; hover over or select one to see
   action names such as **Btw**, **Confirm Current Request**, and
   **Send Message**.

## 10. Test the Claude controls

Select Layer 2 in Input and test one control at a time. Claude can remain behind
another app:

1. Press one of the first six keys and verify Claude opens the matching chat
   from its sidebar. Claude comes forward: it switches chats with its own
   Command-digit shortcut, which a background app ignores.
2. Press **Btw** to send `/btw` in the current chat.
3. Test **Confirm** only when Claude is visibly asking for confirmation.
4. Test **Cancel** while a response is running.
5. Test **Fork** on a response you are comfortable forking; it sends `/fork`.
6. Press either half of the double-width voice key to toggle voice input.
7. Use **Send** only after entering a test prompt.
8. Turn the dial one step in each direction to test zoom, then press it to
   restore actual size.

Confirm, Fork, Voice, and Send change the current Claude task, so test them on a
conversation where those actions are safe.

The top-left key has two gestures:

- Tap: open recent chat 1
- Hold for 400 ms: start a new chat

The firmware owns that key, so the gesture is not in the keymap: the keyboard
reports both edges of the press and the helper times the hold.

### Status colors

The helper can light the six task keys with each chat's live status. Enable
it with:

```sh
node ./bin/claude-micro-layer.mjs lights on
```

The first time, macOS asks for **Input Monitoring** access. Open **System
Settings → Privacy & Security → Input Monitoring** and enable
`claude-micro-focus`. Colors follow the chat status: green blinking while a
chat works, orange blinking when it is waiting on you, red steady once a
finished result is unread, red blinking on error, and dark when idle.

The lights are sent over the keyboard's vendor RPC channel and are never
written to the keymap, so the protected Codex Layer 1 configuration is
untouched. The firmware draws the per-key task lights onto its own agent
keys, which is why this pack maps the first six keys to them rather than to
macros: a macro key gives the firmware nothing to color. Pressing one still
reaches Claude — the keyboard reports the press over its vendor channel and
the helper acts on it. The helper clears the lights when you run
`lights off`, when Claude quits, or when the helper stops. Do not run the
lights while the Codex app is actively driving the keyboard — the firmware
has one shared set of six task lights and the two writers would overwrite
each other.

Colors and polling can be customized in
`~/Library/Application Support/ClaudeMicroLayer/lights.json`
(`colors.pass`, `colors.active`, `colors.done` as `#RRGGBB`,
`pollIntervalMs`, `rpcTimeoutMs`, and `claudeLayerIndex`, zero-based, `-1` to
disable layer gating). Check the current settings with
`node ./bin/claude-micro-layer.mjs lights status`.

While the keyboard sits untouched it sleeps its Bluetooth link and can take up
to a minute or two to repaint; while you are actively using it, lights update
within a few seconds. When the keyboard has fully disconnected, press any key
to wake it.

The statuses come from Claude's sidebar, so **keep the sidebar expanded**
(Cmd+B toggles it). With the sidebar collapsed the chat list is not exposed
to accessibility: the lights go dark and the task keys have nothing to
select. The helper log
(`~/Library/Application Support/ClaudeMicroLayer/claude-micro-focus.log`)
says so explicitly when this is the case.

## Switching layers

The current release installs and syncs Layer 2, but it does not add a physical
layer-switch gesture to the Codex-controlled Layer 1. Select Layer 2 in Work
Louder Input when you want to use the Claude layout.

Input can also switch layers automatically: in the Keymap tab, select Layer 2
and link it to the Claude application. The keyboard then flips to Layer 2
whenever Claude is focused and returns to Layer 1 (the status-light board)
otherwise. The linked-layer state only applies while Claude is frontmost —
that is how Input's app links work — but the Layer 2 controls still reach
Claude in the background because they go through the helper. Reinstalling the
layer pack preserves an existing app link.

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

### Sync reports "Input reported that the keymap write failed"

The keyboard's file layer is most reliable over USB. Plug the keyboard in
with its USB-C cable and run `sync` again. If writes still fail, flip the
keyboard's power switch off and on to reset it, reconnect USB, and retry;
syncing over a sleepy Bluetooth link can wedge the transfer half way.

### Custom Input installation path

Pass the application path explicitly:

```sh
node ./bin/claude-micro-layer.mjs sync \
  --input-app "/full/path/to/input.app"
```

### Holding the top-left key does not start a new chat

First press `Control-Option-Command-N` on the Mac keyboard. If no new chat
opens, reinstall and restart the helper:

```sh
node ./bin/claude-micro-layer.mjs focus-helper install
```

If the keyboard shortcut works but the hold does not, hold the key longer: the
helper treats anything under 400 ms as a tap.

### Task controls or lights stop working after reinstalling the helper

The installer signs the helper with a code-signing identity from your keychain
(or a generated one) so that macOS permission grants survive reinstalls. If no
signing identity is available, the helper falls back to an ad-hoc signature and
every rebuild invalidates the grants. In that case — or after the signature
changes for any reason — open **System Settings → Privacy & Security**, and in
both **Accessibility** and **Input Monitoring** remove `claude-micro-focus`
with the **−** button and re-add it with **+** (toggling alone does not rebind
the entry to the new build).
