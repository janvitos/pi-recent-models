import assert from "node:assert/strict";
import test from "node:test";
import {
	decodeHistory,
	encodeHistory,
	getRecentModels,
	HISTORY_LIMIT,
	modelKey,
	orderWithRecentDuplicates,
	promoteModel,
} from "./utils.ts";

test("model identity includes both provider and model id", () => {
	assert.notEqual(
		modelKey({ provider: "anthropic", id: "shared" }),
		modelKey({ provider: "openai", id: "shared" }),
	);
});

test("promotion is newest-first, de-duplicated, and limited to five", () => {
	let history = Array.from({ length: HISTORY_LIMIT }, (_, index) => ({
		provider: "provider",
		id: `model-${index + 1}`,
	}));
	history = promoteModel(history, { provider: "provider", id: "model-3" });
	assert.deepEqual(history.map((model) => model.id), ["model-3", "model-1", "model-2", "model-4", "model-5"]);

	history = promoteModel(history, { provider: "other", id: "model-6" });
	assert.deepEqual(history.map((model) => `${model.provider}/${model.id}`), [
		"other/model-6",
		"provider/model-3",
		"provider/model-1",
		"provider/model-2",
		"provider/model-4",
	]);
});

test("state decoding accepts versioned and legacy data safely", () => {
	const entries = [
		{ provider: "a", id: "one" },
		{ provider: "a", id: "one" },
		{ provider: "b", id: "two" },
		{ provider: "", id: "invalid" },
	];
	assert.deepEqual(decodeHistory({ version: 1, models: entries }), [
		{ provider: "a", id: "one" },
		{ provider: "b", id: "two" },
	]);
	assert.deepEqual(decodeHistory(entries), [
		{ provider: "a", id: "one" },
		{ provider: "b", id: "two" },
	]);
	assert.deepEqual(decodeHistory({ version: 2, models: entries }), []);
	assert.deepEqual(decodeHistory("corrupt"), []);
	assert.deepEqual(encodeHistory(entries), {
		version: 1,
		models: [
			{ provider: "a", id: "one" },
			{ provider: "b", id: "two" },
		],
	});
});

test("the current model is always first in the recent section", () => {
	const normal = [
		{ provider: "a", id: "one" },
		{ provider: "b", id: "two" },
		{ provider: "c", id: "three" },
	];
	assert.deepEqual(
		getRecentModels(
			normal,
			[{ provider: "a", id: "one" }, { provider: "b", id: "two" }],
			{ provider: "c", id: "three" },
		).map((model) => model.id),
		["three", "one", "two"],
	);
	assert.deepEqual(
		orderWithRecentDuplicates(
			normal,
			[{ provider: "a", id: "one" }],
			{ provider: "c", id: "three" },
		).map((model) => model.id),
		["three", "one", "one", "two", "three"],
	);
});

test("recent available models are duplicated before the unchanged normal list", () => {
	const normal = [
		{ provider: "a", id: "one", marker: 1 },
		{ provider: "b", id: "two", marker: 2 },
		{ provider: "a", id: "three", marker: 3 },
	];
	const ordered = orderWithRecentDuplicates(normal, [
		{ provider: "a", id: "three" },
		{ provider: "a", id: "one" },
	]);
	assert.deepEqual(ordered.map((model) => model.marker), [3, 1, 1, 2, 3]);
	assert.deepEqual(ordered.slice(2), normal);
	assert.equal(ordered[0], normal[2]);
});

test("unavailable and repeated history entries are skipped", () => {
	const normal = [{ provider: "a", id: "one" }];
	assert.deepEqual(orderWithRecentDuplicates(normal, [
		{ provider: "gone", id: "missing" },
		{ provider: "a", id: "one" },
		{ provider: "a", id: "one" },
	]), [normal[0], normal[0]]);
});
