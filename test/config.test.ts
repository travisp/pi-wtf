import assert from "node:assert/strict";
import test from "node:test";
import { createHarness } from "./helpers.ts";

for (const configText of ["[]", "42", '"invalid"', "null", "{"]) {
	test(`invalid config ${configText} blocks model requests but preserves recovery`, async (t) => {
		const h = await createHarness(t, { configText });
		await h.user("mistkae");
		h.assistant();
		await h.run("fuck?");
		assert.equal(h.editorText, "mistkae");
		assert.equal(h.requests.length, 0);
		assert.match(h.notifications.at(-1)!, /Invalid config at/);
		assert.deepEqual(h.widgetUpdates, []);
	});
}

test("invalid config does not block local correction", async (t) => {
	const h = await createHarness(t, { configText: "{" });
	await h.user("/thinkng high");
	h.assistant();
	await h.run("fuck?");
	assert.equal(h.editorText, "/thinking high");
	assert.equal(h.requests.length, 0);
});

test("invalid typo settings preserve configured command words", async (t) => {
	const h = await createHarness(t, { config: { words: ["oops"], typoFix: { thinking: "invalid" } } });
	await h.user("mistkae");
	h.assistant();
	await h.run("oops?");
	assert.equal(h.editorText, "mistkae");
	assert.equal(h.requests.length, 0);
	assert.match(h.notifications.at(-1)!, /typoFix.thinking/);
});
