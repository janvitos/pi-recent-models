import fs from "node:fs";
import path from "node:path";
import {
	getAgentDir,
	ModelSelectorComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	decodeHistory,
	encodeHistory,
	modelKey,
	orderByRecentUse,
	promoteModel,
	type ModelReference,
} from "./utils.ts";

const HISTORY_FILE = path.join(getAgentDir(), "recent-models.json");
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

async function loadHistory(): Promise<ModelReference[]> {
	try {
		return decodeHistory(JSON.parse(await fs.promises.readFile(HISTORY_FILE, "utf8")));
	} catch (error: unknown) {
		if ((error as { code?: unknown }).code === "ENOENT" || error instanceof SyntaxError) return [];
		throw error;
	}
}

async function saveHistory(history: readonly ModelReference[]): Promise<void> {
	await fs.promises.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
	const temporary = `${HISTORY_FILE}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, `${JSON.stringify(encodeHistory(history), null, 2)}\n`, "utf8");
		await fs.promises.rename(temporary, HISTORY_FILE);
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
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
	let history = await loadHistory();
	const patch = installSelectorPatch(history);
	let released = false;
	let saveQueue = Promise.resolve();

	pi.on("model_select", async (event, ctx) => {
		history = promoteModel(history, event.model);
		patch.state.history = history;
		const snapshot = history;
		try {
			saveQueue = saveQueue.then(
				() => saveHistory(snapshot),
				() => saveHistory(snapshot),
			);
			await saveQueue;
		} catch (error: unknown) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not save recent model history: ${detail}`, "warning");
		}
	});

	pi.on("session_shutdown", () => {
		if (released) return;
		released = true;
		patch.release();
	});
}
