# Pi Recent Models

A [Pi coding agent](https://github.com/earendil-works/pi-mono) extension that reorders Pi’s model selector by recent use.

## Behavior

- Tracks model changes from `/model`, Ctrl+L, Ctrl+P cycling, and session restore.
- Keeps one global history shared by every project and session.
- Persists at `~/.pi/agent/recent-models.json` (or the active Pi agent directory).
- Shows one de-duplicated model list: the current model first, then every available previously used model from most to least recent, then never-used models in Pi’s original order.
- Keeps the complete distinct-model history instead of limiting it to five entries. Existing version-1 and legacy history files remain compatible.
- Applies recent ordering in both all-model and scoped-model views.
- Leaves fuzzy-search results in Pi’s normal relevance order.
- Preserves the built-in selector’s model refresh, authentication filtering, highlighting, and keyboard behavior.

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

Pi does not currently expose a public extension hook for reordering the built-in model selector. This extension narrowly wraps the `sortModels()`, `filterModels()`, and `updateList()` methods on Pi’s exported `ModelSelectorComponent`. It calls Pi’s original behavior first where applicable, uses the original ordering for searches, and applies recent ordering to unfiltered all-model and scoped-model lists. It fails clearly during extension loading if a future Pi release removes one of those methods.

## Development

```bash
npm test
npm pack --dry-run
```

## License

[MIT](LICENSE)
