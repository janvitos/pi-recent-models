import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeState, encodeState, RecentModelsStore } from "./state.ts";

async function withTempStore(
	run: (store: RecentModelsStore, statePath: string, legacyPath: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-recent-models-"));
	const statePath = join(directory, "recent-models.json");
	const legacyPath = join(directory, "pi-thinking-memory.json");
	try {
		await run(new RecentModelsStore(statePath, legacyPath), statePath, legacyPath);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("legacy history formats upgrade with thinking memory disabled", () => {
	const models = [{ provider: "openai", id: "sol" }, { provider: "openai", id: "sol" }];
	for (const value of [models, { version: 1, models }]) {
		const decoded = decodeState(value);
		assert.equal(decoded.kind, "current");
		if (decoded.kind !== "current") continue;
		assert.deepEqual(decoded.state.models, [models[0]]);
		assert.equal(decoded.state.inheritModelOnNewSession, false);
		assert.deepEqual(decoded.state.thinkingMemory, {
			enabled: false,
			legacyImported: false,
			preferences: [],
		});
	}
});

test("current state validation repairs invalid entries and encodes deterministically", () => {
	const decoded = decodeState({
		version: 2,
		models: [{ provider: "p", id: "one" }, { provider: "", id: "bad" }],
		inheritModelOnNewSession: "yes",
		thinkingMemory: {
			enabled: true,
			legacyImported: true,
			preferences: [
				{ provider: "z", id: "b", thinkingLevel: "high" },
				{ provider: "a", id: "c", thinkingLevel: "low" },
				{ provider: "a", id: "c", thinkingLevel: "medium" },
				{ provider: "a", id: "bad", thinkingLevel: "turbo" },
			],
		},
	});
	assert.equal(decoded.kind, "current");
	if (decoded.kind !== "current") return;
	assert.ok(decoded.issues.length >= 4);
	assert.equal(decoded.state.inheritModelOnNewSession, false);
	assert.deepEqual(decoded.state.thinkingMemory.preferences.find((entry) => entry.id === "c")?.thinkingLevel, "medium");
	const encoded = JSON.parse(encodeState(decoded.state));
	assert.deepEqual(encoded.thinkingMemory.preferences.map((entry: { provider: string; id: string }) => `${entry.provider}/${entry.id}`), ["a/c", "z/b"]);
	assert.deepEqual(decodeState({ version: 99, models: [] }), { kind: "future", version: 99 });
});

test("new-session model inheritance defaults off and persists independently", async () => {
	await withTempStore(async (store) => {
		assert.equal((await store.load()).inheritModelOnNewSession, false);
		const enabled = await store.setInheritModelOnNewSessionEnabled(true);
		assert.equal(enabled?.inheritModelOnNewSession, true);
		assert.equal((await store.load()).inheritModelOnNewSession, true);
		const disabled = await store.setInheritModelOnNewSessionEnabled(false);
		assert.equal(disabled?.inheritModelOnNewSession, false);
	});
});

test("the feature defaults off and retains preferences while disabled", async () => {
	await withTempStore(async (store) => {
		const sol = { provider: "openai", id: "sol" };
		assert.equal((await store.load()).thinkingMemory.enabled, false);
		await store.setThinkingMemoryEnabled(true);
		assert.equal(await store.setThinkingLevel(sol, "medium"), true);
		await store.setThinkingMemoryEnabled(false);
		assert.equal(await store.getThinkingLevel(sol), undefined);
		const enabled = await store.setThinkingMemoryEnabled(true);
		assert.equal(enabled?.thinkingMemory.preferences[0]?.thinkingLevel, "medium");
		assert.equal(await store.getThinkingLevel(sol), "medium");
	});
});

test("first enable imports legacy preferences once without overwriting integrated values", async () => {
	await withTempStore(async (store, _statePath, legacyPath) => {
		const sol = { provider: "openai", id: "sol" };
		const luna = { provider: "openai", id: "luna" };
		await store.setThinkingMemoryEnabled(true);
		await store.setThinkingLevel(sol, "max");
		await store.setThinkingMemoryEnabled(false);
		// Simulate a pre-existing standalone file before the first successful import.
		const state = await store.load();
		state.thinkingMemory.legacyImported = false;
		await writeFile(store.filePath, encodeState(state));
		await writeFile(legacyPath, JSON.stringify({
			version: 1,
			preferences: [
				{ provider: "openai", model: "sol", thinkingLevel: "medium" },
				{ provider: "openai", model: "luna", thinkingLevel: "high" },
			],
		}));

		const imported = await store.setThinkingMemoryEnabled(true);
		assert.equal(imported?.thinkingMemory.legacyImported, true);
		assert.equal(await store.getThinkingLevel(sol), "max");
		assert.equal(await store.getThinkingLevel(luna), "high");

		await store.setThinkingMemoryEnabled(false);
		await writeFile(legacyPath, JSON.stringify({
			version: 1,
			preferences: [{ provider: "other", model: "new", thinkingLevel: "low" }],
		}));
		const reenabled = await store.setThinkingMemoryEnabled(true);
		assert.equal(reenabled?.thinkingMemory.preferences.some((entry) => entry.provider === "other"), false);
	});
});

test("state writes are private and concurrent stores merge model and thinking updates", async () => {
	await withTempStore(async (first, statePath, legacyPath) => {
		const second = new RecentModelsStore(statePath, legacyPath);
		await first.setThinkingMemoryEnabled(true);
		await Promise.all([
			first.promote({ provider: "openai", id: "sol" }),
			second.setThinkingLevel({ provider: "openai", id: "luna" }, "high"),
		]);
		const state = await first.load();
		assert.equal(state.models.some((entry) => entry.id === "sol"), true);
		assert.equal(state.thinkingMemory.preferences.some((entry) => entry.id === "luna"), true);
		assert.equal((await stat(statePath)).mode & 0o777, 0o600);
	});
});

test("an unknown future schema remains untouched", async () => {
	await withTempStore(async (store, statePath) => {
		const source = `${JSON.stringify({ version: 99, models: [] })}\n`;
		await writeFile(statePath, source);
		assert.equal(await store.promote({ provider: "openai", id: "sol" }), undefined);
		assert.equal(await readFile(statePath, "utf8"), source);
	});
});
