import assert from "node:assert/strict";
import test from "node:test";
import type { ThinkingLevel } from "./state.ts";
import { ThinkingMemory, type ThinkingPreferenceStore } from "./thinking-memory.ts";
import { modelKey, type ModelReference } from "./utils.ts";

class FakeStore implements ThinkingPreferenceStore {
	readonly values = new Map<string, ThinkingLevel>();
	readonly gets: ModelReference[] = [];
	readonly sets: Array<{ model: ModelReference; level: ThinkingLevel }> = [];
	getOverride?: (model: ModelReference) => Promise<ThinkingLevel | undefined>;

	async get(model: ModelReference): Promise<ThinkingLevel | undefined> {
		this.gets.push(model);
		return this.getOverride ? this.getOverride(model) : this.values.get(modelKey(model));
	}

	async set(model: ModelReference, level: ThinkingLevel): Promise<boolean> {
		this.sets.push({ model, level });
		this.values.set(modelKey(model), level);
		return true;
	}

	async drain(): Promise<void> {}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
}

const sol = { provider: "openai", id: "gpt-5.6-sol" };
const luna = { provider: "openai", id: "gpt-5.6-luna" };

function selection(
	model: ModelReference,
	state: { model: ModelReference; level: ThinkingLevel },
	overrides: { source?: "set" | "cycle" | "restore"; pinned?: ThinkingLevel; clamp?: ThinkingLevel } = {},
) {
	return {
		model,
		source: overrides.source ?? ("set" as const),
		pinnedThinkingLevel: overrides.pinned,
		getCurrentModel: () => state.model,
		getEffectiveLevel: () => state.level,
		applyThinkingLevel: (level: ThinkingLevel) => { state.level = overrides.clamp ?? level; },
	};
}

test("startup and unseen models preserve Pi's effective level", async () => {
	const store = new FakeStore();
	const memory = new ThinkingMemory(store);
	const state = { model: luna, level: "high" as ThinkingLevel };
	memory.start(sol, "medium");
	await memory.modelSelected(selection(luna, state));
	assert.equal(state.level, "high");
	assert.deepEqual(store.sets, []);
});

test("ordinary switching restores an exact provider/model preference", async () => {
	const store = new FakeStore();
	store.values.set(modelKey(sol), "medium");
	const memory = new ThinkingMemory(store);
	const state = { model: sol, level: "high" as ThinkingLevel };
	memory.start(luna, "high");
	await memory.modelSelected(selection(sol, state, { source: "cycle" }));
	assert.equal(state.level, "medium");
});

test("session restore takes precedence over memory", async () => {
	const store = new FakeStore();
	store.values.set(modelKey(sol), "medium");
	const memory = new ThinkingMemory(store);
	const state = { model: sol, level: "high" as ThinkingLevel };
	memory.start(luna, "high");
	await memory.modelSelected(selection(sol, state, { source: "restore" }));
	assert.equal(state.level, "high");
	assert.equal(store.gets.length, 0);
});

test("scoped pins apply for direct selection and remain authoritative for cycling", async () => {
	for (const source of ["set", "cycle"] as const) {
		const store = new FakeStore();
		store.values.set(modelKey(sol), "medium");
		const memory = new ThinkingMemory(store);
		const state = { model: sol, level: (source === "set" ? "low" : "high") as ThinkingLevel };
		memory.start(luna, "medium");
		await memory.modelSelected(selection(sol, state, { source, pinned: "high" }));
		assert.equal(state.level, "high");
		assert.equal(store.gets.length, 0);
	}
});

test("clamped restoration normalizes the persisted preference", async () => {
	const store = new FakeStore();
	store.values.set(modelKey(sol), "max");
	const memory = new ThinkingMemory(store);
	const state = { model: sol, level: "low" as ThinkingLevel };
	memory.start(luna, "high");
	await memory.modelSelected(selection(sol, state, { clamp: "high" }));
	assert.equal(state.level, "high");
	assert.deepEqual(store.sets, [{ model: sol, level: "high" }]);
});

test("explicit thinking changes persist while stale and duplicate events do not", async () => {
	const store = new FakeStore();
	const memory = new ThinkingMemory(store);
	memory.start(sol, "medium");
	await memory.thinkingLevelSelected(sol, "medium", "medium");
	await memory.thinkingLevelSelected(sol, "high", "medium");
	await memory.thinkingLevelSelected(luna, "high", "high");
	await memory.thinkingLevelSelected(sol, "high", "high");
	assert.deepEqual(store.sets, [{ model: sol, level: "high" }]);
});

test("an explicit change during lookup prevents restoration", async () => {
	const store = new FakeStore();
	const pending = deferred<ThinkingLevel | undefined>();
	store.getOverride = () => pending.promise;
	const memory = new ThinkingMemory(store);
	const state = { model: sol, level: "low" as ThinkingLevel };
	memory.start(luna, "high");
	const switching = memory.modelSelected(selection(sol, state));
	state.level = "high";
	await memory.thinkingLevelSelected(sol, "high", "high");
	pending.resolve("medium");
	await switching;
	assert.equal(state.level, "high");
	assert.deepEqual(store.sets, [{ model: sol, level: "high" }]);
});

test("a later model switch invalidates an earlier pending restoration", async () => {
	const store = new FakeStore();
	const solLookup = deferred<ThinkingLevel | undefined>();
	store.values.set(modelKey(luna), "high");
	store.getOverride = (model) => modelKey(model) === modelKey(sol)
		? solLookup.promise
		: Promise.resolve(store.values.get(modelKey(model)));
	const memory = new ThinkingMemory(store);
	const state = { model: sol, level: "low" as ThinkingLevel };
	memory.start(luna, "medium");
	const firstSwitch = memory.modelSelected(selection(sol, state));
	state.model = luna;
	state.level = "medium";
	await memory.modelSelected(selection(luna, state));
	assert.equal(state.level, "high");
	solLookup.resolve("max");
	await firstSwitch;
	assert.equal(state.model, luna);
	assert.equal(state.level, "high");
});

test("provider is part of model identity", async () => {
	const store = new FakeStore();
	const proxySol = { provider: "proxy", id: sol.id };
	store.values.set(modelKey(sol), "medium");
	const memory = new ThinkingMemory(store);
	const state = { model: proxySol, level: "high" as ThinkingLevel };
	memory.start(sol, "medium");
	await memory.modelSelected(selection(proxySol, state));
	assert.equal(state.level, "high");
});
