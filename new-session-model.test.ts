import assert from "node:assert/strict";
import test from "node:test";
import { NewSessionModelHandoff } from "./new-session-model.ts";

const sol = { provider: "openai", id: "gpt-5.6-sol" };
const luna = { provider: "openai", id: "gpt-5.6-luna" };

test("an enabled new session inherits the active model once", () => {
	const handoff = new NewSessionModelHandoff();
	handoff.beforeSwitch("new", sol);
	assert.deepEqual(handoff.consume("new", true), sol);
	assert.equal(handoff.consume("new", true), undefined);
});

test("disabled inheritance does not capture or consume a model", () => {
	const handoff = new NewSessionModelHandoff();
	handoff.beforeSwitch("new", sol);
	assert.equal(handoff.consume("new", false), undefined);
	assert.equal(handoff.consume("new", true), undefined);
});

test("resume and other starts never inherit the pending model", () => {
	const handoff = new NewSessionModelHandoff();
	handoff.beforeSwitch("new", sol);
	assert.equal(handoff.consume("resume", true), undefined);
	assert.equal(handoff.consume("new", true), undefined);

	handoff.beforeSwitch("new", sol);
	assert.equal(handoff.consume("startup", true), undefined);
	assert.equal(handoff.consume("new", true), undefined);
});

test("a later switch replaces stale or cancelled new-session state", () => {
	const handoff = new NewSessionModelHandoff();
	handoff.beforeSwitch("new", sol);
	handoff.beforeSwitch("resume", luna);
	assert.equal(handoff.consume("resume", true), undefined);

	handoff.beforeSwitch("new", sol);
	handoff.beforeSwitch("new", luna);
	assert.deepEqual(handoff.consume("new", true), luna);
});

test("non-new shutdown and explicit clearing discard the handoff", () => {
	const handoff = new NewSessionModelHandoff();
	handoff.beforeSwitch("new", sol);
	handoff.beforeShutdown("resume");
	assert.equal(handoff.consume("new", true), undefined);

	handoff.beforeSwitch("new", sol);
	handoff.clear();
	assert.equal(handoff.consume("new", true), undefined);
});
