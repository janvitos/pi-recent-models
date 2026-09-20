# Pi Recent Models

A [Pi coding agent](https://github.com/earendil-works/pi-mono) extension that reorders Pi’s model selector by recent use and can optionally remember a separate thinking level for each model.

## Recent model ordering

- Tracks model changes from `/model`, Ctrl+L, Ctrl+P cycling, and session restore.
- Keeps one global history shared by every project and session.
- Shows the current model first, then every available previously used model from most to least recent, then never-used models in Pi’s original order.
- Keeps the complete distinct-model history and de-duplicates exact provider/model identities.
- Applies recent ordering in both all-model and scoped-model views.
- Leaves fuzzy-search results in Pi’s normal relevance order.
- Preserves the built-in selector’s model refresh, authentication filtering, highlighting, and keyboard behavior.

Pi’s model command is `/model` (singular), and Ctrl+L opens the same selector.

## Inherit the model on `/new`

Model inheritance is **off by default**. Run `/recent-models-settings`, select **Inherit model on /new**, and choose **On** to make a newly created session start with the model selected in the session being replaced.

When enabled:

- `/new` inherits the active session's provider/model selection;
- the inherited selection is recorded in the new session, so sessions remain independent;
- `/resume`, `/fork`, startup, and reload keep Pi's normal session/default-model behavior;
- if the model is unavailable, Pi keeps its normal new-session model and shows a warning.

The handoff is one-shot and process-local. It is not a global last-model preference and does not copy the previous session's thinking level.

## Per-model thinking memory

Thinking memory is **off by default**. Run `/recent-models-settings`, select **Per-model thinking memory**, and choose **On** to enable it globally.

When enabled:

1. select `gpt-5.6-sol` and choose `medium`;
2. switch to `gpt-5.6-luna` and choose `high`;
3. switch back to `gpt-5.6-sol` — Pi returns to `medium`;
4. switch to `gpt-5.6-luna` — Pi returns to `high`.

Preferences use the exact provider and model ID, so `openai/model` and `proxy/model` remain independent. An unseen model keeps Pi’s inherited, capability-clamped level; the extension does not impose a default.

Pi remains authoritative:

- startup and restored-session thinking levels are not replaced;
- a scoped model entry that pins a thinking level wins;
- unsupported saved levels are clamped by Pi and the effective value is saved;
- rapid model switches and manual thinking changes supersede pending restoration work.

Turning the setting off immediately stops recording and restoration but retains saved preferences for later re-enabling.

### Migration from pi-thinking-memory

The first time thinking memory is successfully enabled, valid preferences from `~/.pi/agent/pi-thinking-memory.json` are imported automatically. Existing integrated preferences win duplicates, and the legacy file is left untouched as a backup. The import is recorded and is not repeated.

Remove the standalone `@janvitos/pi-thinking-memory` package before enabling this feature. Loading both extensions would create two authorities responding to the same model and thinking events.

## Storage

Global history, the session-model setting, the thinking-memory setting, and thinking preferences are stored at:

```text
~/.pi/agent/recent-models.json
```

The actual path uses Pi’s active agent directory. Legacy bare-array and version-1 recent-history files upgrade automatically with both optional features disabled. Existing version-2 state without the session-model setting also defaults it to disabled. Updates are serialized, protected by an inter-process lock, merged with current on-disk state, and committed by atomic rename with private file permissions.

Malformed current-version entries are logged and repaired on the next update while valid entries are retained. An unknown newer schema version is not overwritten.

## Requirements

- Pi `0.84.2` or newer
- Node.js `22.6` or newer for development and tests
- TUI mode for the interactive model selector and `/recent-models-settings`

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
pi install ~/src/pi-recent-models
```

For a quick test without installing:

```bash
pi -e ~/src/pi-recent-models/index.ts
```

Do not load multiple copies simultaneously.

## Compatibility note

Pi does not currently expose a public extension hook for reordering the built-in model selector. This extension narrowly wraps the `sortModels()`, `filterModels()`, and `updateList()` methods on Pi’s exported `ModelSelectorComponent`. It calls Pi’s original behavior first where applicable, uses the original ordering for searches, and applies recent ordering to unfiltered all-model and scoped-model lists. It fails clearly during extension loading if a future Pi release removes one of those methods.

Thinking memory uses Pi’s public model and thinking-level events.

## Development

```bash
npm install
npm test
npm pack --dry-run
```

The tests cover recent ordering, state validation and migration, concurrent persistence, exact model identities, default-off and enable/disable behavior, new-session model inheritance, session and scoped-model precedence, clamping, delayed thinking events, and rapid model switches.

## License

[MIT](LICENSE)
