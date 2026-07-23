# Contributing

Contributions are welcome, especially tested Claude workflows and validation
for Windows or Linux.

## Add a layer

1. Export a layer with the CLI or copy `layers/claude-starter.json`.
2. Remove personal paths, application identifiers, and private macro content.
3. Give the layer a descriptive name and document its intended application.
4. Run `npm test` and `node ./bin/claude-micro-layer.mjs validate <file>`.
5. Open a pull request explaining the physical mapping and tested versions.

Layer packs must target `codex_micro`, use format version `1`, and must not try
to replace Layer 1.

## Development

The project deliberately uses only Node.js built-ins. Keep changes focused and
add a `node:test` case for behavior changes.

Never run installation tests against a contributor's live Input keymap. Tests
must use temporary fixtures and should verify that Layer 1 remains byte-for-byte
equivalent as parsed JSON.
