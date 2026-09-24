import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createHarness } from "./helpers.ts";

for (const { position, answered } of [
	{ position: "linear", answered: true },
	{ position: "branch", answered: true },
	{ position: "root", answered: true },
	{ position: "root with sibling", answered: true },
	{ position: "linear", answered: false },
	{ position: "root", answered: false },
] as const) {
	test(`destructive recovery preserves context after reload: ${position}, answered=${answered}`, async (t) => {
		const h = await createHarness(t);
		if (position !== "root") {
			await h.user("original");
			const originalLeaf = h.assistant();
			if (position === "branch") {
				await h.user("other branch");
				h.assistant();
				h.sm.branch(originalLeaf);
			}
		}
		if (position === "root" || position === "root with sibling") {
			h.sm.resetLeaf();
		}
		const parentId = h.sm.getLeafId();
		const expectedContext = h.sm.buildSessionContext().messages;
		const survivors = h.sm.getEntries();
		const removedId = await h.user("mistkae");
		if (answered) h.assistant();
		const file = h.sm.getSessionFile()!;

		await h.run();

		assert.equal(h.editorText, "mistkae");
		assert.equal(h.sm.getEntry(removedId), undefined);
		assert.deepEqual(h.sm.getEntries().slice(0, survivors.length), survivors);
		// Resuming an empty context can append model/thinking metadata after the anchor.
		const anchor = h.sm.getBranch().find((entry) => entry.type === "custom" && entry.customType === "pi-wtf-recovery");
		assert.ok(anchor);
		assert.equal(anchor.parentId, parentId);
		assert.deepEqual(h.sm.buildSessionContext().messages, expectedContext);
		assert.deepEqual(h.messages, expectedContext);
		// The selected branch must survive another process opening the same file.
		assert.deepEqual(SessionManager.open(file).buildSessionContext().messages, expectedContext);
		await h.run();
		assert.match(h.notifications.at(-1)!, /only works immediately/);
	});
}

for (const command of ["fuck", "fuck?"] as const) {
	for (const { root, answered } of [
		{ root: false, answered: true },
		{ root: false, answered: false },
		{ root: true, answered: false },
	]) {
		test(`/${command} restores the prompt and rewinds context: root=${root}, answered=${answered}`, async (t) => {
			const h = await createHarness(t, { suggestion: "mistkae" });
			if (root) h.sm.resetLeaf();
			else {
				await h.user("original");
				h.assistant();
			}
			const parentId = h.sm.getLeafId();
			const expectedContext = h.sm.buildSessionContext().messages;
			const userId = await h.user("mistkae");
			if (answered) h.assistant();
			h.editorText = "existing draft";

			await h.run(command);

			assert.equal(h.editorText, "mistkae");
			assert.equal(h.sm.getLeafId(), parentId);
			assert.deepEqual(h.sm.buildSessionContext().messages, expectedContext);
			assert.deepEqual(h.messages, expectedContext);
			assert.ok(h.sm.getEntry(userId), "non-destructive recovery retains raw history");
			await h.run();
			assert.match(h.notifications.at(-1)!, /only works immediately/);
		});
	}
}

for (const [outcome, event] of [
	["success", { type: "session_compact" }],
	["failure", { type: "session_compact_failed", aborted: false }],
	["abort", { type: "session_compact_failed", aborted: true }],
] as const) {
	test(`recovery is available after compaction ${outcome}`, async (t) => {
		const h = await createHarness(t);
		await h.user("mistake");
		h.assistant();
		await h.emit({ type: "session_before_compact" });
		await h.run();
		assert.match(h.notifications.at(-1)!, /during compaction/);
		await h.emit(event);
		await h.run();
		assert.equal(h.editorText, "mistake");
		assert.deepEqual(h.sm.buildSessionContext().messages, []);
	});
}

for (const outcome of ["cancel", "throw"] as const) {
	test(`destructive recovery restores the session file when reload ${outcome}s`, async (t) => {
		const h = await createHarness(t);
		await h.user("mistake");
		h.assistant();
		const file = h.sm.getSessionFile()!;
		const original = readFileSync(file, "utf8");
		t.mock.method(h.ctx, "switchSession", async () => {
			if (outcome === "throw") throw new Error("reload failed");
			return { cancelled: true };
		});
		if (outcome === "throw") await assert.rejects(h.run(), /reload failed/);
		else await h.run();
		assert.equal(readFileSync(file, "utf8"), original);
	});
}

test("cancelled navigation leaves the session file untouched", async (t) => {
	const h = await createHarness(t);
	await h.user("mistake");
	h.assistant();
	const file = h.sm.getSessionFile()!;
	const original = readFileSync(file, "utf8");
	t.mock.method(h.ctx, "navigateTree", async () => ({ cancelled: true }));
	await h.run();
	assert.equal(readFileSync(file, "utf8"), original);
});

for (const command of ["fuck", "fuck?", "fuck!"] as const) {
	test(`/${command} respects cancelled navigation from an unanswered root prompt`, async (t) => {
		const h = await createHarness(t);
		h.sm.resetLeaf();
		const userId = await h.user("mistkae");
		const expectedContext = h.sm.buildSessionContext().messages;
		t.mock.method(h.ctx, "navigateTree", async (targetId: string) => {
			assert.equal(targetId, userId);
			assert.notEqual(h.sm.getLeafId(), userId, "marker makes navigation actionable");
			return { cancelled: true };
		});
		await h.run(command);
		assert.ok(h.sm.getEntry(userId));
		assert.deepEqual(h.sm.buildSessionContext().messages, expectedContext);
		assert.equal(h.editorText, "");
		assert.equal(h.requests.length, 0);
		assert.match(h.notifications.at(-1)!, /Recovery cancelled/);
	});

	test(`/${command} rejects queued messages without changing history`, async (t) => {
		const h = await createHarness(t);
		await h.user("mistake");
		const entries = h.sm.getEntries();
		t.mock.method(h.ctx, "hasPendingMessages", () => true);
		await h.run(command);
		assert.deepEqual(h.sm.getEntries(), entries);
		assert.equal(h.editorText, "");
		assert.match(h.notifications.at(-1)!, /queued messages/);
	});
}

test("recovery aborts and waits for active work before navigating", async (t) => {
	const h = await createHarness(t);
	await h.user("mistake");
	h.assistant();
	const calls: string[] = [];
	t.mock.method(h.ctx, "isIdle", () => false);
	t.mock.method(h.ctx, "abort", () => { calls.push("abort"); });
	t.mock.method(h.ctx, "waitForIdle", async () => { calls.push("idle"); });
	const navigate = h.ctx.navigateTree;
	t.mock.method(h.ctx, "navigateTree", async (id: string) => {
		assert.deepEqual(calls, ["abort", "idle"]);
		return navigate(id);
	});
	await h.run("fuck");
	assert.equal(h.editorText, "mistake");
});

test("destructive recovery preserves compacted and edited context across reload", async (t) => {
	const h = await createHarness(t);
	h.sm.appendMessage({ role: "system", content: "Keep instructions", toolsAdded: [], timestamp: Date.now() });
	await h.user("summarized history");
	h.assistant();
	const kept = await h.user("retained prompt");
	h.assistant();
	h.sm.appendCompaction("Earlier work", kept, 100);
	h.sm.appendContextEdit(kept, { content: "corrected retained prompt" });
	const expected = h.sm.buildSessionContext().messages;
	await h.user("mistkae");
	h.assistant();
	await h.run();
	assert.deepEqual(h.messages, expected);
	assert.deepEqual(SessionManager.open(h.sm.getSessionFile()!).buildSessionContext().messages, expected);
});
