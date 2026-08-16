# Pi Recent Models

A [Pi coding agent](https://github.com/earendil-works/pi-mono) extension that shows the five most recently used models, newest first, above Pi’s complete built-in model selector list.

## Behavior

- Tracks model changes from `/model`, Ctrl+L, Ctrl+P cycling, and session restore.
- Keeps one global history shared by every project and session.
- Persists at `~/.pi/agent/recent-models.json` (or the active Pi agent directory).
- Prepends up to five available recent models to the selector, with the current model always first.
- Labels the two colored sections **Recent Models** and **All Models**, with a blank line between them.
- Intentionally leaves recent models in the complete list below, so every recent entry is duplicated.
- Preserves the built-in selector’s search, all/scoped toggle, model refresh, authentication filtering, highlighting, and keyboard behavior.

Pi’s model command is `/model` (singular), and Ctrl+L opens the same selector.

## Requirements

- Pi `0.84.2` or newer
- Node.js `22.6` or newer for the test command
- TUI mode for the interactive model selector

## Install

```bash
pi install npm:@janvitos/pi-recent-models
```

Start a new Pi process after installation, or run `/reload` in an existing session.

### Install from GitHub

```bash
pi install git:github.com/janvitos/pi-recent-models
```

### Local development install

```bash
git clone https://github.com/janvitos/pi-recent-models.git ~/src/pi-recent-models
ln -s ~/src/pi-recent-models ~/.pi/agent/extensions/pi-recent-models
```

For a quick test without installing:

```bash
pi -e ~/src/pi-recent-models/index.ts
```

Do not load multiple copies simultaneously.

## Compatibility note

Pi does not currently expose a public extension hook for reordering the built-in model selector. This extension narrowly wraps the `sortModels()` method on Pi’s exported `ModelSelectorComponent`, calls Pi’s original sorter first, and then prepends the recent duplicates. It fails clearly during extension loading if a future Pi release removes that method.

## Development

```bash
npm test
npm pack --dry-run
```

## License

[MIT](LICENSE)
