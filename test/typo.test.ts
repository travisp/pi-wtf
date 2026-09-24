import assert from "node:assert/strict";
import test from "node:test";

import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createHarness } from "./helpers.ts";

for (const accept of [true, false]) {
	test(`typo correction uses normalized context and resolved auth; accept=${accept}`, async (t) => {
		const h = await createHarness(t);
		await h.user("mistkae");
		h.assistant();
		h.confirmResult = accept;
		await h.run("fuck?");

		assert.equal(h.requests.length, 1);
		const { model, context, options } = h.requests[0];
		assert.match(getCurrentSystemPrompt(context.messages), /Preserve the user's meaning exactly/);
		assert.deepEqual(getCurrentTools(context.messages).map((tool) => tool.name), ["prompt_typo_fixed"]);
		assert.equal(context.messages.at(-1)?.role, "user");
		assert.match(JSON.stringify(context.messages.at(-1)), /mistkae/);
		assert.equal(model.baseUrl, "https://authenticated.invalid");
		assert.equal(options?.apiKey, "test-key");
		assert.equal(options?.headers?.["x-test"], "authenticated");
		assert.equal(options?.env?.TEST_REGION, "test-region");
		assert.equal(options?.cacheRetention, "none");
		assert.deepEqual(h.widgetUpdates, [
			["Checking typos: pi-wtf-test/test · thinking: unspecified (requested)"],
			undefined,
		]);
		assert.equal(h.confirmations.length, 1);
		assert.equal(h.editorText, accept ? "mistake" : "mistkae");
		assert.equal(h.statuses.get("pi-wtf"), undefined);
		assert.equal(h.widgets.get("pi-wtf-typo"), undefined);
	});
}

for (const thinking of [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
	test(`uses configured model and thinking=${thinking} without changing session`, async (t) => {
		const h = await createHarness(t, { config: { typoFix: { model: "pi-wtf-test/other/model", thinking } } });
		const sessionModel = h.session.model;
		const sessionThinking = h.session.thinkingLevel;
		await h.user("mistkae");
		h.assistant();
		await h.run("fuck?");
		assert.equal(h.requests.length, 1);
		assert.equal(h.requests[0].model.id, "other/model");
		assert.equal((h.requests[0].options as { reasoning?: string }).reasoning, thinking === "off" ? undefined : thinking);
		assert.deepEqual(h.widgetUpdates, [
			[`Checking typos: pi-wtf-test/other/model · thinking: ${thinking ?? "unspecified"} (requested)`],
			undefined,
		]);
		assert.equal(h.session.model, sessionModel);
		assert.equal(h.session.thinkingLevel, sessionThinking);
		assert.equal(h.editorText, "mistake");
	});
}

test("thinking-only configuration follows live session model without changing its thinking", async (t) => {
	const h = await createHarness(t, { config: { typoFix: { thinking: "low" } } });
	const selected = h.ctx.modelRegistry.find("pi-wtf-test", "other/model")!;
	await h.session.setModel(selected);
	h.session.setThinkingLevel("high");
	await h.user("mistkae");
	h.assistant();
	await h.run("fuck?");
	assert.equal(h.requests[0].model.id, selected.id);
	assert.equal(h.session.model, selected);
	assert.equal(h.session.thinkingLevel, "high");
	assert.equal((h.requests[0].options as { reasoning?: string }).reasoning, "low");
});

for (const typoFix of [null, [], { model: "test" }, { model: 42 }, { thinking: "invalid" }, { model: "missing/model" }]) {
	test(`invalid typo config ${JSON.stringify(typoFix)} preserves prompt without a request`, async (t) => {
		const h = await createHarness(t, { config: { typoFix } });
		await h.user("mistkae");
		h.assistant();
		await h.run("fuck?");
		assert.equal(h.requests.length, 0);
		assert.equal(h.editorText, "mistkae");
		assert.match(h.notifications.at(-1)!, /failed:.*(?:config|typoFix)/);
		assert.equal(h.statuses.get("pi-wtf"), undefined);
	});
}

for (const stopReason of ["error", "aborted"] as const) {
	test(`typo correction keeps the restored prompt on model ${stopReason}`, async (t) => {
		const h = await createHarness(t, { stopReason });
		await h.user("mistkae");
		h.assistant();
		await h.run("fuck?");
		assert.equal(h.editorText, "mistkae");
		assert.equal(h.confirmations.length, 0);
		assert.match(h.notifications.at(-1)!, /failed/);
		assert.equal(h.statuses.get("pi-wtf"), undefined);
		assert.equal(h.widgets.get("pi-wtf-typo"), undefined);
	});
}

for (const [original, corrected] of [["/thinkng high", "/thinking high"], ["/bgu problem", "/bug problem"]]) {
	for (const accept of [true, false]) {
		test(`corrects ${original} locally without a model request; accept=${accept}`, async (t) => {
			const h = await createHarness(t, { config: { typoFix: { thinking: "invalid" } } });
			h.confirmResult = accept;
			await h.user(original);
			h.assistant();
			await h.run("fuck?");
			assert.equal(h.editorText, accept ? corrected : original);
			assert.deepEqual(h.widgetUpdates, []);
			assert.equal(h.requests.length, 0);
			assert.equal(h.confirmations.length, 1);
			assert.match(h.confirmations[0], /^Possible command typo detected:/);
		});
	}
}
