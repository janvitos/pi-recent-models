import assert from "node:assert/strict";
import test from "node:test";
import {
	decodeHistory,
	encodeHistory,
	modelKey,
	orderByRecentUse,
	promoteModel,
} from "./utils.ts";

test("model identity includes both provider and model id", () => {
	assert.notEqual(
		modelKey({ provider: "anthropic", id: "shared" }),
		modelKey({ provider: "openai", id: "shared" }),
	);
});

test("promotion is newest-first, de-duplicated, and does not truncate history", () => {
	let history = Array.from({ length: 8 }, (_, index) => ({
		provider: "provider",
		id: `model-${index + 1}`,
	}));
	history = promoteModel(history, { provider: "provider", id: "model-3" });
	assert.deepEqual(history.map((model) => model.id), [
		"model-3",
		"model-1",
		"model-2",
		"model-4",
		"model-5",
		"model-6",
		"model-7",
		"model-8",
	]);

	history = promoteModel(history, { provider: "other", id: "model-9" });
	assert.equal(history.length, 9);
	assert.deepEqual(history.slice(0, 3).map((model) => `${model.provider}/${model.id}`), [
		"other/model-9",
		"provider/model-3",
		"provider/model-1",
	]);
});

test("state decoding accepts versioned and legacy data without a five-model limit", () => {
	const entries = [
		...Array.from({ length: 7 }, (_, index) => ({ provider: "p", id: `model-${index + 1}` })),
		{ provider: "p", id: "model-1" },
		{ provider: "", id: "invalid" },
	];
	const expected = entries.slice(0, 7);

	assert.deepEqual(decodeHistory({ version: 1, models: entries }), expected);
	assert.deepEqual(decodeHistory(entries), expected);
	assert.deepEqual(decodeHistory({ version: 2, models: entries }), []);
	assert.deepEqual(decodeHistory("corrupt"), []);
	assert.deepEqual(encodeHistory(entries), { version: 1, models: expected });
});

test("the current model is first, followed by recent models and then the original list order", () => {
	const normal = [
		{ provider: "a", id: "one", marker: 1 },
		{ provider: "b", id: "two", marker: 2 },
		{ provider: "c", id: "three", marker: 3 },
		{ provider: "d", id: "four", marker: 4 },
	];
	const ordered = orderByRecentUse(
		normal,
		[{ provider: "a", id: "one" }, { provider: "b", id: "two" }],
		{ provider: "c", id: "three" },
	);

	assert.deepEqual(ordered.map((model) => model.id), ["three", "one", "two", "four"]);
	assert.equal(ordered[0], normal[2]);
	assert.equal(ordered.length, normal.length);
});

test("every available model appears exactly once even when inputs contain duplicates", () => {
	const one = { provider: "a", id: "one", marker: 1 };
	const duplicateOne = { provider: "a", id: "one", marker: 99 };
	const two = { provider: "b", id: "two", marker: 2 };
	const ordered = orderByRecentUse(
		[one, two, duplicateOne],
		[
			{ provider: "b", id: "two" },
			{ provider: "b", id: "two" },
			{ provider: "a", id: "one" },
		],
	);

	assert.deepEqual(ordered, [two, one]);
});

test("unavailable history entries are skipped and never-used models keep their relative order", () => {
	const normal = [
		{ provider: "a", id: "one" },
		{ provider: "b", id: "two" },
		{ provider: "c", id: "three" },
	];
	assert.deepEqual(orderByRecentUse(normal, [
		{ provider: "gone", id: "missing" },
		{ provider: "b", id: "two" },
	]), [normal[1], normal[0], normal[2]]);
});
