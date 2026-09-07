import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	AgentSession,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionEvent,
	type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import piWtf from "../src/pi-wtf.ts";

function createHarness(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "pi-wtf-recovery-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	});

	let sessionManager = SessionManager.create(directory, directory);
	let editorText = "";
	const notifications: string[] = [];
	const commands = new Map<string, RegisteredCommand>();
	type TestEvent = Partial<ExtensionEvent> & { type: ExtensionEvent["type"] };
	type EventHandler = (event: TestEvent, ctx: ExtensionCommandContext) => unknown;
	const handlers = new Map<string, EventHandler>();
	const emit = async (event: TestEvent) => handlers.get(event.type)!(event, ctx);
	const ctx = {
		get sessionManager() { return sessionManager; },
		ui: {
			notify: (message: string) => notifications.push(message),
			setEditorText: (text: string) => { editorText = text; },
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		async navigateTree(targetId: string) {
			// Exercise Pi's real navigation without starting a model or terminal UI.
			const result = await AgentSession.prototype.navigateTree.call({
				isStreaming: false,
				sessionManager,
				agent: { state: { messages: [] } },
				_extensionRunner: { hasHandlers: () => false, emit },
				_resolveIdleWaitIfIdle: () => {},
			} as unknown as AgentSession, targetId);
			if (result.editorText) editorText = result.editorText;
			return result;
		},
		async switchSession(file: string, { withSession }: { withSession: (ctx: ExtensionCommandContext) => Promise<void> }) {
			sessionManager = SessionManager.open(file, directory);
			editorText = "";
			await emit({ type: "session_start", reason: "resume" });
			await withSession(ctx);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;

	piWtf({
		registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
		on(name: string, handler: EventHandler) { handlers.set(name, handler); },
	} as unknown as ExtensionAPI);

	return {
		ctx,
		emit,
		notifications,
		get editorText() { return editorText; },
		get sm() { return sessionManager; },
		async user(text: string) {
			const message = { role: "user" as const, content: text, timestamp: Date.now() };
			const id = sessionManager.appendMessage(message);
			await emit({ type: "message_start", message });
			return id;
		},
		assistant() {
			return sessionManager.appendMessage({
				role: "assistant", content: [{ type: "text", text: "reply" }],
				api: "openai-responses", provider: "openai", model: "test", stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		},
		run: () => commands.get("fuck!")!.handler("", ctx),
	};
}

for (const position of ["linear", "branch", "root", "root with sibling", "unanswered"] as const) {
	test(`destructive recovery preserves context after reload: ${position}`, async (t) => {
		const h = createHarness(t);
		let parentId: string | null = null;
		if (position !== "root") {
			await h.user("original");
			parentId = h.assistant();
		}
		if (position === "branch") {
			await h.user("other branch");
			h.assistant();
			h.sm.branch(parentId!);
		}
		if (position === "root with sibling") {
			h.sm.resetLeaf();
			parentId = null;
		}
		const expectedContext = h.sm.buildSessionContext().messages;
		const survivors = h.sm.getEntries();
		const removedId = await h.user("mistkae");
		if (position !== "unanswered") h.assistant();
		const file = h.sm.getSessionFile()!;

		await h.run();

		assert.equal(h.editorText, "mistkae");
		assert.equal(h.sm.getEntry(removedId), undefined);
		assert.deepEqual(h.sm.getEntries().slice(0, -1), survivors);
		assert.equal(h.sm.getLeafEntry()!.parentId, parentId);
		assert.deepEqual(h.sm.buildSessionContext().messages, expectedContext);
		// The selected branch must survive another process opening the same file.
		assert.deepEqual(SessionManager.open(file).buildSessionContext().messages, expectedContext);
		await h.run();
		assert.match(h.notifications.at(-1)!, /only works immediately/);
	});
}

for (const [outcome, event] of [
	["success", { type: "session_compact" }],
	["failure", { type: "session_compact_failed", aborted: false }],
	["abort", { type: "session_compact_failed", aborted: true }],
] as const) {
	test(`recovery is available after compaction ${outcome}`, async (t) => {
		const h = createHarness(t);
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
		const h = createHarness(t);
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
	const h = createHarness(t);
	await h.user("mistake");
	h.assistant();
	const file = h.sm.getSessionFile()!;
	const original = readFileSync(file, "utf8");
	t.mock.method(h.ctx, "navigateTree", async () => ({ cancelled: true }));
	await h.run();
	assert.equal(readFileSync(file, "utf8"), original);
});
