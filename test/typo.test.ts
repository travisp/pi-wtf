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
		assert.equal(h.confirmations.length, 1);
		assert.equal(h.editorText, accept ? "mistake" : "mistkae");
		assert.equal(h.statuses.get("pi-wtf"), undefined);
		assert.equal(h.widgets.get("pi-wtf-typo"), undefined);
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
	test(`corrects ${original} locally without a model request`, async (t) => {
		const h = await createHarness(t);
		await h.user(original);
		h.assistant();
		await h.run("fuck?");
		assert.equal(h.editorText, corrected);
		assert.equal(h.requests.length, 0);
		assert.equal(h.confirmations.length, 1);
	});
}
