import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import {
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type AssistantMessage,
	type Model,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionEvent,
	type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import piWtf from "../src/pi-wtf.ts";

export async function createHarness(t: TestContext, options: {
	config?: unknown;
	suggestion?: string;
	stopReason?: "toolUse" | "error" | "aborted";
} = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-wtf-recovery-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	let session: AgentSession;
	t.after(() => {
		session?.dispose();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(directory, { recursive: true, force: true });
	});

	if (options.config !== undefined) {
		writeFileSync(join(directory, "wtf.json"), JSON.stringify(options.config));
	}

	const model: Model<"openai-responses"> = {
		id: "test",
		name: "Test",
		provider: "pi-wtf-test",
		api: "openai-responses",
		baseUrl: "https://unconfigured.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const reply: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "reply" }],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const correction: AssistantMessage = {
		...reply,
		content: [{
			type: "toolCall",
			id: "correction",
			name: "prompt_typo_fixed",
			arguments: { correctedPrompt: options.suggestion ?? "mistake" },
		}],
		stopReason: options.stopReason ?? "toolUse",
		errorMessage: options.stopReason === "error" ? "Test provider failed" : undefined,
	};
	const requests: { model: Model<string>; context: TranscriptContext; options?: StreamOptions }[] = [];
	const stream = (model: Model<string>, context: TranscriptContext, options?: StreamOptions) => {
		requests.push({ model, context, options });
		const events = createAssistantMessageEventStream();
		events.end(correction);
		return events;
	};
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStorePath: join(directory, "models-store.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider({
		id: model.provider, name: "Test", getModels: () => [model, { ...model, id: "other/model", reasoning: true }],
		auth: { apiKey: {
			name: "Test auth",
			resolve: async () => ({
				auth: { apiKey: "test-key", headers: { "x-test": "authenticated" }, baseUrl: "https://authenticated.invalid" },
				env: { TEST_REGION: "test-region" },
			}),
		} },
		stream,
		streamSimple: stream,
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await resourceLoader.reload();
	const openSession = async (sessionManager: SessionManager) => (await createAgentSession({
		cwd: directory, agentDir: directory, model, modelRuntime, resourceLoader,
		settingsManager, sessionManager, tools: [], thinkingLevel: "off",
	})).session;
	session = await openSession(SessionManager.create(directory, directory));

	let editorText = "";
	let confirmResult = true;
	const notifications: string[] = [];
	const confirmations: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const widgetUpdates: (string[] | undefined)[] = [];
	const commands = new Map<string, RegisteredCommand>();
	type TestEvent = Partial<ExtensionEvent> & { type: ExtensionEvent["type"] };
	type EventHandler = (event: TestEvent, ctx: ExtensionCommandContext) => unknown;
	const handlers = new Map<string, EventHandler>();
	const emit = async (event: TestEvent) => handlers.get(event.type)!(event, ctx);
	// Only the host UI/event adapter is mocked. Navigation and context rebuilding
	// use real SDK sessions; no Pi private state or prototype methods are borrowed.
	const ctx = {
		get sessionManager() { return session.sessionManager; },
		model,
		modelRegistry: new ModelRegistry(modelRuntime),
		ui: {
			notify: (message: string) => notifications.push(message),
			setEditorText: (text: string) => { editorText = text; },
			confirm: async (title: string, message: string) => { confirmations.push(`${title}\n${message}`); return confirmResult; },
			setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
			setWidget: (key: string, value: string[] | undefined) => {
				widgets.set(key, value);
				widgetUpdates.push(value);
			},
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => { void session.abort(); },
		waitForIdle: () => session.waitForIdle(),
		async navigateTree(targetId: string) {
			const oldLeafId = session.sessionManager.getLeafId();
			const result = await session.navigateTree(targetId);
			if (!result.cancelled && oldLeafId !== targetId) {
				await emit({ type: "session_tree" });
			}
			return result;
		},
		async switchSession(file: string, { withSession }: { withSession: (ctx: ExtensionCommandContext) => Promise<void> }) {
			session.dispose();
			session = await openSession(SessionManager.open(file, directory));
			editorText = "";
			await emit({ type: "session_start", reason: "resume" });
			await withSession(ctx);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;

	piWtf({
		registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
		on(name: string, handler: EventHandler) { handlers.set(name, handler); },
		appendEntry(customType: string) { session.sessionManager.appendCustomEntry(customType); },
		getCommands: () => [...commands.keys()].map((name) => ({ name, source: "extension" })),
	} as unknown as ExtensionAPI);

	return {
		ctx, emit, notifications, confirmations, statuses, widgets, widgetUpdates, requests,
		get editorText() { return editorText; },
		set editorText(value: string) { editorText = value; },
		set confirmResult(value: boolean) { confirmResult = value; },
		get sm() { return session.sessionManager; },
		get messages() { return session.messages; },
		async user(text: string) {
			const message = { role: "user" as const, content: text, timestamp: Date.now() };
			const id = session.sessionManager.appendMessage(message);
			await emit({ type: "message_start", message });
			return id;
		},
		assistant: () => session.sessionManager.appendMessage(reply),
		run: (name = "fuck!") => commands.get(name)!.handler("", ctx),
	};
}
