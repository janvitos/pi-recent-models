import fs from "node:fs";
import path from "node:path";
import {
	getAgentDir,
	ModelSelectorComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component } from "@earendil-works/pi-tui";
import {
	decodeHistory,
	encodeHistory,
	getRecentModels,
	promoteModel,
	type ModelReference,
} from "./utils.ts";

const HISTORY_FILE = path.join(getAgentDir(), "recent-models.json");
const PATCH_KEY = Symbol.for("@janvitos/pi-recent-models/model-selector-patch");
const RECENT_ITEM = Symbol("pi-recent-models/recent-item");
const MAX_VISIBLE_MODELS = 10;

interface SelectorModelItem extends ModelReference {
	model: unknown;
}
interface SelectorInstance {
	currentModel?: ModelReference;
	activeModels: SelectorModelItem[];
	filteredModels: SelectorModelItem[];
	selectedIndex: number;
	listContainer: { children: Component[] };
	updateList?(): void;
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
	history: ModelReference[];
	formatHeader(text: string): string;
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

function isRecentItem(item: SelectorModelItem | undefined): boolean {
	return !!item && (item as SelectorModelItem & Record<PropertyKey, unknown>)[RECENT_ITEM] === true;
}

function addSectionHeaders(selector: SelectorInstance, state: PatchState): void {
	const { filteredModels, listContainer, selectedIndex } = selector;
	const startIndex = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(MAX_VISIBLE_MODELS / 2),
			filteredModels.length - MAX_VISIBLE_MODELS,
		),
	);
	const endIndex = Math.min(startIndex + MAX_VISIBLE_MODELS, filteredModels.length);
	const visible = filteredModels.slice(startIndex, endIndex);
	const components = listContainer.children;
	const header = (label: string) => new Text(state.formatHeader(`  ${label}`), 0, 0);

	if (visible.length === 0) {
		components.unshift(header("All Models"));
		return;
	}

	let inserted = 0;
	if (isRecentItem(visible[0])) {
		components.unshift(header("Recent Models"));
		inserted += 1;
	}

	const firstAllIndex = visible.findIndex((item) => !isRecentItem(item));
	if (firstAllIndex >= 0) {
		components.splice(firstAllIndex + inserted, 0, new Spacer(1), header("All Models"));
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
		history,
		formatHeader: (text) => text,
		users: 1,
	};

	prototype.sortModels = function (models) {
		const normalModels = state.originalSort.call(this, models);
		const recentModels = getRecentModels(normalModels, state.history, this.currentModel).map((item) => ({
			...item,
			[RECENT_ITEM]: true,
		}));
		return [...recentModels, ...normalModels];
	};
	prototype.updateList = function () {
		state.originalUpdate.call(this);
		addSectionHeaders(this, state);
	};
	prototype.filterModels = function (query) {
		state.originalFilter.call(this, query);
		if (this.activeModels.some((item) => isRecentItem(item))) {
			this.filteredModels = [
				...this.filteredModels.filter((item) => isRecentItem(item)),
				...this.filteredModels.filter((item) => !isRecentItem(item)),
			];
		} else {
			const recentModels = getRecentModels(this.filteredModels, state.history, this.currentModel).map((item) => ({
				...item,
				[RECENT_ITEM]: true,
			}));
			this.filteredModels = [...recentModels, ...this.filteredModels];
		}
		const first = this.filteredModels[0];
		if (
			first &&
			this.currentModel &&
			first.provider === this.currentModel.provider &&
			first.id === this.currentModel.id
		) {
			this.selectedIndex = 0;
		}
		this.updateList?.();
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

	pi.on("session_start", (_event, ctx) => {
		patch.state.formatHeader = (text) => ctx.ui.theme.fg("accent", ctx.ui.theme.bold(text));
	});

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
