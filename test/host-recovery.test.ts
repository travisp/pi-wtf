import assert from "node:assert/strict";
import test from "node:test";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	SessionManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import piWtf from "../src/pi-wtf.ts";
import { createHarness } from "./helpers.ts";

// Real extension loading, command dispatch, lifecycle events and runtime replacement;
// only the terminal UI and model transport are simulated.
test("host runtime rewrites complex history, accepts a corrected turn, and reopens", async (t) => {
	const h = await createHarness(t, { plainReply: true });
	const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir, modelRuntime: h.modelRuntime, settingsManager: h.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [piWtf],
			},
		});
		return {
			...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: h.model, noTools: "all" }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd: h.directory, agentDir: h.directory, sessionManager: SessionManager.create(h.directory, h.directory) });
	t.after(() => runtime.dispose());
	let editor = "";
	const errors: unknown[] = [];
	const bind = async (session: AgentSession) => {
		editor = "";
		await session.bindExtensions({
			mode: "tui",
			uiContext: { ...session.extensionRunner.getUIContext(), setEditorText: (text) => { editor = text; } },
			onError: (error) => { errors.push(error); },
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				fork: (id, options) => runtime.fork(id, options),
				navigateTree: (id, options) => session.navigateTree(id, options),
				switchSession: (file, options) => runtime.switchSession(file, options),
				reload: async () => { throw new Error("Unexpected reload"); },
			},
		});
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	await runtime.session.prompt("Earlier work");
	const sm = runtime.session.sessionManager;
	const branchPoint = sm.getLeafId()!;
	await runtime.session.prompt("Alternative to preserve");
	sm.appendCustomEntry("fixture-state", { nested: [1, "keep"] });
	sm.appendLabelChange(sm.getLeafId()!, "saved alternative");
	await runtime.session.navigateTree(branchPoint);
	await runtime.session.prompt("Retained work");
	const kept = sm.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
	sm.appendCompaction("Earlier work summarized", kept.id, 100);
	sm.appendContextEdit(kept.id, { content: "Edited retained work" });
	sm.appendCustomMessageEntry("fixture-context", "Remember this", false);
	// Compare persisted values: JSON omits optional properties whose value is undefined.
	const survivors = JSON.parse(JSON.stringify(sm.getEntries()));
	const expectedContext = sm.buildSessionContext().messages;
	const header = JSON.parse(JSON.stringify(sm.getHeader()));
	await runtime.session.prompt("mistkae");
	const removed = sm.getEntries().slice(survivors.length).map((entry) => entry.id);
	const oldSession = runtime.session;
	const file = sm.getSessionFile()!;
	await runtime.session.prompt("/fuck!");
	assert.notEqual(runtime.session, oldSession);
	assert.equal(editor, "mistkae");
	assert.equal(runtime.session.sessionFile, file);
	assert.deepEqual(runtime.session.sessionManager.getHeader(), header);
	assert.deepEqual(runtime.session.sessionManager.getEntries().slice(0, survivors.length), survivors);
	for (const id of removed) assert.equal(runtime.session.sessionManager.getEntry(id), undefined);
	assert.deepEqual(runtime.session.messages, expectedContext);
	assert.deepEqual(SessionManager.open(file).buildSessionContext().messages, expectedContext);
	await runtime.session.prompt("corrected prompt");
	assert.equal(runtime.session.getLastAssistantText(), "reply");
	const corrected = runtime.session.sessionManager.buildSessionContext().messages;
	await runtime.switchSession(file);
	assert.deepEqual(runtime.session.messages, corrected);
	// Flush timers after the second replacement to catch stale-context callbacks.
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(errors, []);
});
