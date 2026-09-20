import path from "node:path";
import {
	getAgentDir,
	ModelSelectorComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { RecentModelsStore, type ThinkingLevel } from "./state.ts";
import { NewSessionModelHandoff } from "./new-session-model.ts";
import { ThinkingMemory } from "./thinking-memory.ts";
import {
	modelKey,
	orderByRecentUse,
	promoteModel,
	type ModelReference,
} from "./utils.ts";

const STATE_FILE = path.join(getAgentDir(), "recent-models.json");
const LEGACY_THINKING_FILE = path.join(getAgentDir(), "pi-thinking-memory.json");
const newSessionModelHandoff = new NewSessionModelHandoff();
const PATCH_KEY = Symbol.for("@janvitos/pi-recent-models/model-selector-patch");

interface SelectorModelItem extends ModelReference {
	model: unknown;
}
interface SelectorInstance {
	currentModel?: ModelReference;
	allModels: SelectorModelItem[];
	activeModels: SelectorModelItem[];
	filteredModels: SelectorModelItem[];
	selectedIndex: number;
	getSearchInput?(): { getValue(): string };
}

type SortModels = (this: SelectorInstance, models: SelectorModelItem[]) => SelectorModelItem[];
type UpdateList = (this: SelectorInstance) => void;
type FilterModels = (this: SelectorInstance, query: string) => void;
type SelectorPrototype = {
	sortModels?: SortModels;
	updateList?: UpdateList;
	filterModels?: FilterModels;
} & Record<PropertyKey, unknown>;
interface PatchState {
	originalSort: SortModels;
	originalUpdate: UpdateList;
	originalFilter: FilterModels;
	normalAllModels: WeakMap<SelectorInstance, SelectorModelItem[]>;
	history: ModelReference[];
	users: number;
}

function sameModelOrder(a: readonly ModelReference[], b: readonly ModelReference[]): boolean {
	return a.length === b.length && a.every((model, index) => modelKey(model) === modelKey(b[index]!));
}

function orderUnfilteredModels(selector: SelectorInstance, history: readonly ModelReference[]): void {
	if ((selector.getSearchInput?.().getValue() ?? "").length > 0) return;
	const previous = selector.filteredModels;
	const ordered = orderByRecentUse(previous, history, selector.currentModel);
	if (sameModelOrder(previous, ordered)) return;

	const selected = previous[selector.selectedIndex];
	selector.filteredModels = ordered;
	if (selected) {
		const selectedKey = modelKey(selected);
		const newIndex = ordered.findIndex((model) => modelKey(model) === selectedKey);
		selector.selectedIndex = newIndex >= 0 ? newIndex : 0;
	} else {
		selector.selectedIndex = Math.min(selector.selectedIndex, Math.max(0, ordered.length - 1));
	}
}

function installSelectorPatch(history: ModelReference[]): { state: PatchState; release(): void } {
	const prototype = ModelSelectorComponent.prototype as unknown as SelectorPrototype;
	const installed = prototype[PATCH_KEY] as PatchState | undefined;
	if (installed) {
		installed.users += 1;
		installed.history = history;
		return {
			state: installed,
			release: () => releaseSelectorPatch(prototype, installed),
		};
	}

	if (
		typeof prototype.sortModels !== "function" ||
		typeof prototype.updateList !== "function" ||
		typeof prototype.filterModels !== "function"
	) {
		throw new Error(
			"pi-recent-models requires a Pi version whose exported ModelSelectorComponent exposes sortModels(), filterModels(), and updateList()",
		);
	}

	const state: PatchState = {
		originalSort: prototype.sortModels,
		originalUpdate: prototype.updateList,
		originalFilter: prototype.filterModels,
		normalAllModels: new WeakMap(),
		history,
		users: 1,
	};

	prototype.sortModels = function (models) {
		const normalModels = state.originalSort.call(this, models);
		state.normalAllModels.set(this, normalModels);
		return orderByRecentUse(normalModels, state.history, this.currentModel);
	};
	prototype.updateList = function () {
		orderUnfilteredModels(this, state.history);
		state.originalUpdate.call(this);
	};
	prototype.filterModels = function (query) {
		const activeModels = this.activeModels;
		const normalAllModels = state.normalAllModels.get(this);
		if (query.length > 0 && activeModels === this.allModels && normalAllModels) {
			this.activeModels = normalAllModels;
			try {
				state.originalFilter.call(this, query);
			} finally {
				this.activeModels = activeModels;
			}
			return;
		}
		state.originalFilter.call(this, query);
	};
	prototype[PATCH_KEY] = state;
	return {
		state,
		release: () => releaseSelectorPatch(prototype, state),
	};
}

function releaseSelectorPatch(prototype: SelectorPrototype, state: PatchState): void {
	if (prototype[PATCH_KEY] !== state) return;
	state.users -= 1;
	if (state.users > 0) return;
	prototype.sortModels = state.originalSort;
	prototype.updateList = state.originalUpdate;
	prototype.filterModels = state.originalFilter;
	delete prototype[PATCH_KEY];
}

export default async function recentModels(pi: ExtensionAPI): Promise<void> {
	const store = new RecentModelsStore(STATE_FILE, LEGACY_THINKING_FILE);
	let initialState = await store.load();
	if (initialState.thinkingMemory.enabled && !initialState.thinkingMemory.legacyImported) {
		initialState = await store.setThinkingMemoryEnabled(true) ?? initialState;
	}
	let history = initialState.models;
	let thinkingEnabled = initialState.thinkingMemory.enabled;
	let inheritModelOnNewSession = initialState.inheritModelOnNewSession;
	const patch = installSelectorPatch(history);
	const memory = new ThinkingMemory({
		get: (model) => store.getThinkingLevel(model),
		set: (model, level) => store.setThinkingLevel(model, level),
		drain: () => store.drain(),
	});
	let released = false;

	pi.registerCommand("recent-models-settings", {
		description: "Configure recent-model and session model preferences",
		handler: async (_args, ctx) => {
			const thinkingSetting = `Per-model thinking memory (active: ${thinkingEnabled ? "on" : "off"})`;
			const inheritSetting = `Inherit model on /new (active: ${inheritModelOnNewSession ? "on" : "off"})`;
			const selected = await ctx.ui.select("Recent models settings", [thinkingSetting, inheritSetting]);
			if (selected === undefined) return;

			if (selected === thinkingSetting) {
				const choice = await ctx.ui.select("Remember a thinking level for each model", ["Off (default)", "On"]);
				if (choice === undefined) return;
				const enabled = choice === "On";
				const state = await store.setThinkingMemoryEnabled(enabled);
				if (!state) {
					ctx.ui.notify("Could not save recent-model settings.", "error");
					return;
				}
				thinkingEnabled = enabled;
				if (enabled) memory.start(ctx.model, pi.getThinkingLevel());
				else await memory.stop();
				ctx.ui.notify(`Per-model thinking memory ${enabled ? "on" : "off"}.`, "info");
				return;
			}

			const choice = await ctx.ui.select("Inherit the current model when creating a new session", ["Off (default)", "On"]);
			if (choice === undefined) return;
			const enabled = choice === "On";
			const state = await store.setInheritModelOnNewSessionEnabled(enabled);
			if (!state) {
				ctx.ui.notify("Could not save recent-model settings.", "error");
				return;
			}
			inheritModelOnNewSession = enabled;
			if (!enabled) newSessionModelHandoff.clear();
			ctx.ui.notify(`Model inheritance on /new ${enabled ? "on" : "off"}.`, "info");
		},
	});

	pi.on("session_before_switch", (event, ctx) => {
		if (!inheritModelOnNewSession) {
			newSessionModelHandoff.clear();
			return;
		}
		newSessionModelHandoff.beforeSwitch(event.reason, ctx.model);
	});

	pi.on("session_start", async (event, ctx) => {
		const inheritedModel = newSessionModelHandoff.consume(event.reason, inheritModelOnNewSession);
		if (inheritedModel) {
			const model = ctx.modelRegistry.find(inheritedModel.provider, inheritedModel.id);
			if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
				ctx.ui.notify(
					`Could not inherit model ${inheritedModel.provider}/${inheritedModel.id}; using Pi's normal new-session model.`,
					"warning",
				);
			} else if (!ctx.model || modelKey(ctx.model) !== modelKey(model)) {
				const applied = await pi.setModel(model);
				if (!applied) {
					ctx.ui.notify(
						`Could not inherit model ${inheritedModel.provider}/${inheritedModel.id}; using Pi's normal new-session model.`,
						"warning",
					);
				}
			}
		}
		if (thinkingEnabled) memory.start(ctx.model, pi.getThinkingLevel());
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!thinkingEnabled) return;
		await memory.thinkingLevelSelected(ctx.model, event.level, pi.getThinkingLevel());
	});

	pi.on("model_select", async (event, ctx) => {
		history = promoteModel(history, event.model);
		patch.state.history = history;

		const historyUpdate = store.promote(event.model).then((state) => {
			if (!state) {
				ctx.ui.notify("Could not save recent model history.", "warning");
				return;
			}
			history = state.models;
			patch.state.history = history;
		});
		const thinkingUpdate = thinkingEnabled
			? memory.modelSelected({
				model: event.model,
				source: event.source,
				pinnedThinkingLevel: ctx.scopedModels.find(
					(entry) => entry.model.provider === event.model.provider && entry.model.id === event.model.id,
				)?.thinkingLevel as ThinkingLevel | undefined,
				getCurrentModel: () => ctx.model,
				getEffectiveLevel: () => pi.getThinkingLevel(),
				applyThinkingLevel: (level) => pi.setThinkingLevel(level),
			})
			: Promise.resolve();
		await Promise.all([historyUpdate, thinkingUpdate]);
	});

	pi.on("session_shutdown", async (event) => {
		newSessionModelHandoff.beforeShutdown(event.reason);
		if (released) return;
		released = true;
		patch.release();
		await memory.stop();
		await store.drain();
	});
}
