import type { ModelReference } from "./utils.ts";
import { modelKey } from "./utils.ts";
import type { ThinkingLevel } from "./state.ts";

export interface ThinkingPreferenceStore {
	get(model: ModelReference): Promise<ThinkingLevel | undefined>;
	set(model: ModelReference, thinkingLevel: ThinkingLevel): Promise<boolean>;
	drain(): Promise<void>;
}

export type ModelSelectSource = "set" | "cycle" | "restore";

export interface ModelSelection {
	model: ModelReference;
	source: ModelSelectSource;
	pinnedThinkingLevel: ThinkingLevel | undefined;
	getCurrentModel(): ModelReference | undefined;
	getEffectiveLevel(): ThinkingLevel;
	applyThinkingLevel(level: ThinkingLevel): void;
}

interface ActiveModel {
	model: ModelReference;
	effectiveLevel: ThinkingLevel;
	generation: number;
	revision: number;
}

function sameModel(left: ModelReference | undefined, right: ModelReference | undefined): boolean {
	return left !== undefined && right !== undefined && modelKey(left) === modelKey(right);
}

export class ThinkingMemory {
	private readonly store: ThinkingPreferenceStore;
	private active: ActiveModel | undefined;
	private nextGeneration = 0;

	constructor(store: ThinkingPreferenceStore) {
		this.store = store;
	}

	start(model: ModelReference | undefined, effectiveLevel: ThinkingLevel): void {
		this.active = model
			? { model, effectiveLevel, generation: ++this.nextGeneration, revision: 0 }
			: undefined;
	}

	async stop(): Promise<void> {
		this.active = undefined;
		this.nextGeneration += 1;
		await this.store.drain();
	}

	async thinkingLevelSelected(
		model: ModelReference | undefined,
		level: ThinkingLevel,
		currentEffectiveLevel: ThinkingLevel,
	): Promise<void> {
		const active = this.active;
		if (!active || !sameModel(active.model, model)) return;
		if (level !== currentEffectiveLevel || level === active.effectiveLevel) return;

		active.effectiveLevel = level;
		active.revision += 1;
		await this.store.set(active.model, level);
	}

	async modelSelected(selection: ModelSelection): Promise<void> {
		const generation = ++this.nextGeneration;
		const inheritedLevel = selection.getEffectiveLevel();
		const active: ActiveModel = {
			model: selection.model,
			effectiveLevel: inheritedLevel,
			generation,
			revision: 0,
		};
		this.active = active;

		if (selection.source === "restore") return;
		if (selection.pinnedThinkingLevel !== undefined) {
			if (selection.source === "set") {
				selection.applyThinkingLevel(selection.pinnedThinkingLevel);
				if (this.isCurrentGeneration(selection, generation)) active.effectiveLevel = selection.getEffectiveLevel();
			}
			return;
		}

		const savedLevel = await this.store.get(selection.model);
		if (savedLevel === undefined || !this.canRestore(selection, generation, 0, inheritedLevel)) return;

		selection.applyThinkingLevel(savedLevel);
		const effectiveLevel = selection.getEffectiveLevel();
		if (!this.isCurrentGeneration(selection, generation)) return;

		active.effectiveLevel = effectiveLevel;
		if (effectiveLevel !== savedLevel) await this.store.set(selection.model, effectiveLevel);
	}

	private canRestore(
		selection: ModelSelection,
		generation: number,
		revision: number,
		inheritedLevel: ThinkingLevel,
	): boolean {
		const active = this.active;
		return active?.generation === generation && active.revision === revision &&
			sameModel(active.model, selection.model) && sameModel(selection.getCurrentModel(), selection.model) &&
			selection.getEffectiveLevel() === inheritedLevel;
	}

	private isCurrentGeneration(selection: ModelSelection, generation: number): boolean {
		return this.active?.generation === generation && sameModel(this.active.model, selection.model) &&
			sameModel(selection.getCurrentModel(), selection.model);
	}
}
