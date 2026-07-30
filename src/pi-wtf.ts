import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type UserMessageEntry = SessionEntry & { type: "message"; message: { role: "user" } };

const DEFAULT_COMMAND_WORD = "fuck";
const CONFIG_FILE_NAME = "wtf.json";
const COMMAND_WORD_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeCommandWords(words: unknown): string[] {
	if (!Array.isArray(words)) {
		return [];
	}

	const normalizedWords = new Set<string>();
	for (const word of words) {
		if (typeof word !== "string") {
			continue;
		}

		const trimmedWord = word.trim();
		if (COMMAND_WORD_PATTERN.test(trimmedWord)) {
			normalizedWords.add(trimmedWord);
		}
	}

	return [...normalizedWords];
}

function loadConfiguredWords(): { words: string[]; invalidConfigPath?: string } {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	if (!existsSync(configPath)) {
		return { words: [DEFAULT_COMMAND_WORD] };
	}

	try {
		const config = JSON.parse(readFileSync(configPath, "utf-8")) as { words?: unknown };
		const words = normalizeCommandWords(config.words);
		if (words.length > 0) {
			return { words };
		}
		return { words: [DEFAULT_COMMAND_WORD], invalidConfigPath: configPath };
	} catch {
		return { words: [DEFAULT_COMMAND_WORD], invalidConfigPath: configPath };
	}
}

function isUserMessageEntry(entry: SessionEntry): entry is UserMessageEntry {
	return entry.type === "message" && entry.message.role === "user";
}

function getLastUserMessage(entries: SessionEntry[]): UserMessageEntry | undefined {
	return entries.findLast(isUserMessageEntry);
}

function extractUserMessageText(entry: UserMessageEntry): string {
	const { content } = entry.message;
	return typeof content === "string"
		? content
		: content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function hasImageAttachments(entry: UserMessageEntry): boolean {
	return Array.isArray(entry.message.content) && entry.message.content.some((block) => block.type === "image");
}

function collectSubtreeIds(entries: SessionEntry[], rootId: string): Set<string> {
	const childrenByParentId = new Map<string, string[]>();

	for (const entry of entries) {
		if (entry.parentId === null) {
			continue;
		}

		const children = childrenByParentId.get(entry.parentId) ?? [];
		children.push(entry.id);
		childrenByParentId.set(entry.parentId, children);
	}

	const subtreeIds = new Set<string>();
	const stack = [rootId];

	while (stack.length > 0) {
		const currentId = stack.pop()!;
		subtreeIds.add(currentId);
		for (const childId of childrenByParentId.get(currentId) ?? []) {
			stack.push(childId);
		}
	}

	return subtreeIds;
}

export function removeEntrySubtree(entries: SessionEntry[], rootId: string): SessionEntry[] {
	const removedIds = collectSubtreeIds(entries, rootId);
	return entries.filter((entry) => {
		if (removedIds.has(entry.id)) {
			return false;
		}

		if (entry.type === "label" && removedIds.has(entry.targetId)) {
			return false;
		}

		return true;
	});
}

function serializeSession(header: SessionHeader, entries: SessionEntry[]): string {
	return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function rewriteSessionInPlace(sessionFile: string, content: string): void {
	const tempFile = join(dirname(sessionFile), `.pi-wtf-${randomUUID()}.tmp`);
	const mode = statSync(sessionFile).mode;

	try {
		writeFileSync(tempFile, content, { mode });
		renameSync(tempFile, sessionFile);
	} finally {
		rmSync(tempFile, { force: true });
	}
}

export async function rewriteSessionForReplacement(
	sessionFile: string,
	content: string,
	replaceSession: () => Promise<{ cancelled: boolean }>,
): Promise<boolean> {
	const originalContent = readFileSync(sessionFile, "utf-8");
	rewriteSessionInPlace(sessionFile, content);

	let replaced = false;
	try {
		replaced = !(await replaceSession()).cancelled;
		return replaced;
	} finally {
		if (!replaced) {
			rewriteSessionInPlace(sessionFile, originalContent);
		}
	}
}

// pi.getCommands() returns extension, prompt-template, and skill commands, but not
// built-in interactive commands. Keep this small list in sync with pi's built-ins.
const BUILTIN_SLASH_COMMANDS = [
	"settings",
	"model",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"debug",
	"quit",
];

function getSlashCommandNames(pi: ExtensionAPI): string[] {
	return [...new Set([...BUILTIN_SLASH_COMMANDS, ...pi.getCommands().map((command) => command.name)])];
}

function parseSlashCommandPrompt(prompt: string): { commandName: string; rest: string } | undefined {
	const match = /^\/(\S+)([\s\S]*)$/.exec(prompt);
	if (!match) {
		return undefined;
	}

	const [, commandName, rest] = match;
	return { commandName, rest };
}

function levenshteinDistance(a: string, b: string): number {
	let previousRow = Array.from({ length: b.length + 1 }, (_, index) => index);

	for (let i = 0; i < a.length; i++) {
		const currentRow = [i + 1];
		for (let j = 0; j < b.length; j++) {
			currentRow.push(
				Math.min(
					currentRow[j] + 1,
					previousRow[j + 1] + 1,
					previousRow[j] + (a[i] === b[j] ? 0 : 1),
				),
			);
		}
		previousRow = currentRow;
	}

	return previousRow[b.length];
}

const MAX_SLASH_COMMAND_TYPO_DISTANCE = 2;

export function findClosestSlashCommand(commandName: string, commandNames: string[]): string | undefined {
	if (commandNames.includes(commandName)) {
		return undefined;
	}

	let closestCommand: string | undefined;
	let closestDistance = Number.POSITIVE_INFINITY;

	for (const candidate of commandNames) {
		const distance = levenshteinDistance(commandName, candidate);
		if (distance < closestDistance) {
			closestCommand = candidate;
			closestDistance = distance;
		}
	}

	if (!closestCommand || closestDistance > MAX_SLASH_COMMAND_TYPO_DISTANCE) {
		return undefined;
	}

	return closestCommand;
}

async function offerSlashCommandTypoFix(
	commandName: string,
	originalPrompt: string,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	const parsed = parseSlashCommandPrompt(originalPrompt);
	if (!parsed) {
		return false;
	}

	const closestCommand = findClosestSlashCommand(parsed.commandName, getSlashCommandNames(pi));
	if (!closestCommand) {
		return false;
	}

	const suggestion = `/${closestCommand}${parsed.rest}`;
	const useSuggestion = await ctx.ui.confirm(
		"Possible command typo detected:",
		[
			"Original:",
			originalPrompt,
			"",
			"Suggested:",
			suggestion,
			"",
			"Choose Yes to replace the restored prompt, or No to keep the original.",
		].join("\n"),
	);

	if (useSuggestion) {
		ctx.ui.setEditorText(suggestion);
		ctx.ui.notify(`${commandName}: changed /${parsed.commandName} to /${closestCommand}`, "info");
	} else {
		ctx.ui.notify(`${commandName}: kept original prompt`, "info");
	}

	return true;
}

const TYPO_FIX_SYSTEM_PROMPT = [
	"You are correcting a user prompt that was accidentally sent to a coding agent.",
	"Correct only obvious spelling typos, accidental duplicated words, and minor punctuation or grammar mistakes.",
	"",
	"Rules:",
	"- Preserve the user's meaning exactly.",
	"- Do not add requirements.",
	"- Do not remove requirements.",
	"- Do not make the prompt more specific.",
	"- Do not improve prompt quality.",
	"- Do not rephrase.",
	"- Preserve formatting, newlines, indentation, markdown, and code blocks.",
	"- If unsure, return the original prompt unchanged.",
	"",
	"Call the prompt_typo_fixed tool with the corrected prompt itself, not JSON and not wrapped in any other format.",
].join("\n");

const TYPO_FIX_TOOL = {
	name: "prompt_typo_fixed",
	description: "Return the user's prompt with only obvious typos corrected",
	parameters: Type.Object({
		correctedPrompt: Type.String({
			description: "The corrected prompt, preserving the user's original meaning and formatting",
		}),
	}),
};

function buildTypoFixUserPrompt(originalPrompt: string): string {
	return [
		"Correct only obvious typos in this prompt and return the corrected prompt via the tool.",
		"Do not return JSON. Do not include the <prompt> tags.",
		"",
		"<prompt>",
		originalPrompt,
		"</prompt>",
	].join("\n");
}

async function suggestTypoFix(originalPrompt: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("No model available for typo correction", "warning");
		return undefined;
	}

	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) {
		ctx.ui.notify(`No provider available for ${model.provider}`, "warning");
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		ctx.ui.notify(auth.error, "warning");
		return undefined;
	}

	const response = await provider
		.stream(
			model,
			{
				systemPrompt: TYPO_FIX_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: buildTypoFixUserPrompt(originalPrompt) }],
						timestamp: Date.now(),
					},
				],
				tools: [TYPO_FIX_TOOL],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				cacheRetention: "none",
			},
		)
		.result();

	for (const content of response.content) {
		if (content.type !== "toolCall" || content.name !== "prompt_typo_fixed") {
			continue;
		}

		const correctedPrompt = content.arguments.correctedPrompt;
		if (typeof correctedPrompt === "string") {
			return correctedPrompt;
		}
	}

	ctx.ui.notify("Model did not return a typo correction", "warning");
	return undefined;
}

async function offerTypoFix(
	commandName: string,
	originalPrompt: string,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (await offerSlashCommandTypoFix(commandName, originalPrompt, pi, ctx)) {
		return;
	}

	ctx.ui.setStatus("pi-wtf", "Checking prompt for typos...");
	ctx.ui.setWidget("pi-wtf-typo", ["pi-wtf: checking restored prompt for typos..."]);
	try {
		const suggestion = await suggestTypoFix(originalPrompt, ctx);
		if (suggestion === undefined) {
			return;
		}

		if (suggestion === originalPrompt) {
			ctx.ui.notify(`${commandName}: no obvious typo fix found`, "info");
			return;
		}

		const useSuggestion = await ctx.ui.confirm(
			"Use typo-fixed prompt?",
			[
				"Original:",
				originalPrompt,
				"",
				"Suggested:",
				suggestion,
				"",
				"Choose Yes to replace the restored prompt, or No to keep the original.",
			].join("\n"),
		);

		if (useSuggestion) {
			ctx.ui.setEditorText(suggestion);
			ctx.ui.notify(`${commandName}: applied suggestion`, "info");
		} else {
			ctx.ui.notify(`${commandName}: kept original prompt`, "info");
		}
	} catch (error) {
		ctx.ui.notify(`${commandName} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	} finally {
		ctx.ui.setStatus("pi-wtf", undefined);
		ctx.ui.setWidget("pi-wtf-typo", undefined);
	}
}

export default function piWtf(pi: ExtensionAPI) {
	const config = loadConfiguredWords();
	const commandWords = config.words;
	let isCompacting = false;
	let isDestructiveCommandActive = false;

	const clearCompactionState = () => {
		isCompacting = false;
	};

	const clearDestructiveCommandActivation = () => {
		isDestructiveCommandActive = false;
	};

	const resetSessionState = () => {
		clearCompactionState();
		clearDestructiveCommandActivation();
	};

	const prepareCommand = async (commandName: string, ctx: ExtensionCommandContext) => {
		if (isCompacting) {
			ctx.ui.notify(
				`Can't /${commandName} during compaction. Press Esc to cancel compaction, then run /${commandName} again.`,
				"warning",
			);
			return false;
		}

		if (ctx.hasPendingMessages()) {
			ctx.ui.notify(
				`Can't /${commandName} while queued messages exist. Restore or send them first.`,
				"warning",
			);
			return false;
		}

		if (!ctx.isIdle()) {
			ctx.abort();
			await ctx.waitForIdle();
		}

		return true;
	};

	const rejectUnexpectedArgs = (commandName: string, args: string, ctx: ExtensionCommandContext) => {
		if (!args.trim()) {
			return false;
		}

		ctx.ui.notify(`Usage: /${commandName}`, "warning");
		return true;
	};

	const recoverLastPrompt = async (commandName: string, ctx: ExtensionCommandContext) => {
		if (!(await prepareCommand(commandName, ctx))) {
			return undefined;
		}

		const lastUserMessage = getLastUserMessage(ctx.sessionManager.getBranch());
		if (!lastUserMessage) {
			ctx.ui.notify("Nothing to recover on this branch. Use /tree for manual navigation.", "info");
			return undefined;
		}

		if (hasImageAttachments(lastUserMessage)) {
			ctx.ui.notify(
				`Can't /${commandName}: prompts with image attachments can't be restored. Use /tree for manual navigation.`,
				"warning",
			);
			return undefined;
		}

		const originalPrompt = extractUserMessageText(lastUserMessage);
		const result = await ctx.navigateTree(lastUserMessage.id);
		if (result.cancelled) {
			ctx.ui.notify("Recovery cancelled.", "info");
			return undefined;
		}

		ctx.ui.notify(`${commandName}: navigated back to last prompt`, "info");
		return originalPrompt;
	};

	const destructivelyRecoverLastPrompt = async (commandName: string, ctx: ExtensionCommandContext) => {
		if (!isDestructiveCommandActive) {
			ctx.ui.notify(
				`Can't /${commandName} now. It only works immediately during or after a user prompt.`,
				"warning",
			);
			return;
		}

		if (!(await prepareCommand(commandName, ctx))) {
			return;
		}

		const lastUserMessage = getLastUserMessage(ctx.sessionManager.getBranch());
		if (!lastUserMessage) {
			ctx.ui.notify("Nothing to remove on this branch.", "info");
			return;
		}

		if (hasImageAttachments(lastUserMessage)) {
			ctx.ui.notify(
				`Can't /${commandName}: prompts with image attachments can't be restored. Use /tree for manual navigation.`,
				"warning",
			);
			return;
		}

		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionHeader = ctx.sessionManager.getHeader();
		if (!sessionFile || !sessionHeader) {
			ctx.ui.notify("Current session can't be rewritten safely.", "warning");
			return;
		}

		// Restore the prompt into the editor first, then delete that prompt's subtree from disk.
		if ((await ctx.navigateTree(lastUserMessage.id)).cancelled) {
			ctx.ui.notify("Recovery cancelled.", "info");
			return;
		}

		const rewrittenSession = serializeSession(
			sessionHeader,
			removeEntrySubtree(ctx.sessionManager.getEntries(), lastUserMessage.id),
		);
		const replaced = await rewriteSessionForReplacement(sessionFile, rewrittenSession, () =>
			ctx.switchSession(sessionFile, {
				withSession: async (replacementCtx) => {
					// Pi reports "Resumed session" after withSession returns, so defer this
					// notification until the session switch has fully finished.
					setTimeout(() => {
						replacementCtx.ui.notify(
							`${commandName}: navigated back to last prompt and dropped messages from session`,
							"info",
						);
					}, 0);
				},
			}),
		);

		if (!replaced) {
			ctx.ui.notify(`${commandName}: session reload cancelled; no messages were deleted`, "info");
		}
	};

	const registerCommandSet = (commandWord: string) => {
		pi.registerCommand(commandWord, {
			description: "Abort the current run and recover the last prompt",
			handler: async (args, ctx) => {
				if (rejectUnexpectedArgs(commandWord, args, ctx)) {
					return;
				}

				await recoverLastPrompt(commandWord, ctx);
			},
		});

		const typoCommandName = `${commandWord}?`;
		pi.registerCommand(typoCommandName, {
			description: "Abort the current run, recover the last prompt, and suggest a typo fix",
			handler: async (args, ctx) => {
				if (rejectUnexpectedArgs(typoCommandName, args, ctx)) {
					return;
				}

				const originalPrompt = await recoverLastPrompt(typoCommandName, ctx);
				if (originalPrompt !== undefined) {
					await offerTypoFix(typoCommandName, originalPrompt, pi, ctx);
				}
			},
		});

		const destructiveCommandName = `${commandWord}!`;
		pi.registerCommand(destructiveCommandName, {
			description: "Destructively rewrite the current session to remove the last prompt subtree",
			handler: async (args, ctx) => {
				if (rejectUnexpectedArgs(destructiveCommandName, args, ctx)) {
					return;
				}

				await destructivelyRecoverLastPrompt(destructiveCommandName, ctx);
			},
		});
	};

	pi.on("session_start", (_event, ctx) => {
		resetSessionState();
		if (config.invalidConfigPath) {
			// /reload reports its own status after extensions restart, so defer this
			// notification until the reload flow has finished updating the UI.
			setTimeout(() => {
				ctx.ui.notify(
					`pi-wtf: invalid config at ${config.invalidConfigPath}; using /${DEFAULT_COMMAND_WORD}.`,
					"warning",
				);
			}, 0);
		}
	});
	pi.on("input", clearDestructiveCommandActivation);
	pi.on("message_start", (event) => {
		if (event.message.role === "user") {
			isDestructiveCommandActive = true;
		}
	});
	pi.on("session_tree", clearDestructiveCommandActivation);
	pi.on("session_before_compact", ({ signal }) => {
		isCompacting = true;
		signal.addEventListener("abort", clearCompactionState, { once: true });
	});
	pi.on("session_compact", clearCompactionState);

	for (const commandWord of commandWords) {
		registerCommandSet(commandWord);
	}
}
