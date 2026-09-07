import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	findClosestSlashCommand,
	normalizeCommandWords,
	removeEntrySubtree,
	rewriteSessionForReplacement,
	rewriteSessionInPlace,
} from "../src/pi-wtf.ts";

function createSessionFile(content: string): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-wtf-test-"));
	const sessionFile = join(directory, "session.jsonl");
	writeFileSync(sessionFile, content);
	return sessionFile;
}

test("normalizes configured command words", () => {
	assert.deepEqual(normalizeCommandWords([" oops ", "oops", "doh-2", "bad word", 42]), ["oops", "doh-2"]);
	assert.deepEqual(normalizeCommandWords("oops"), []);
});

test("finds only nearby unknown slash commands", () => {
	const commands = ["settings", "tree", "trust"];
	assert.equal(findClosestSlashCommand("tre", commands), "tree");
	assert.equal(findClosestSlashCommand("tree", commands), undefined);
	assert.equal(findClosestSlashCommand("unrelated", commands), undefined);
});

test("removes an entry subtree and labels that target it", () => {
	const timestamp = "2026-01-01T00:00:00.000Z";
	const entries: SessionEntry[] = [
		{ type: "custom", id: "root", parentId: null, timestamp, customType: "test", data: {} },
		{ type: "custom", id: "drop", parentId: "root", timestamp, customType: "test", data: {} },
		{ type: "custom", id: "child", parentId: "drop", timestamp, customType: "test", data: {} },
		{ type: "custom", id: "keep", parentId: "root", timestamp, customType: "test", data: {} },
		{ type: "label", id: "label", parentId: "keep", timestamp, targetId: "drop", label: "mistake" },
	];

	assert.deepEqual(
		removeEntrySubtree(entries, "drop").map((entry) => entry.id),
		["root", "keep"],
	);
});

test("reparents surviving children through removed labels without mutating the original tree", () => {
	const timestamp = "2026-01-01T00:00:00.000Z";
	const entries: SessionEntry[] = [
		{ type: "custom", id: "drop", parentId: null, timestamp, customType: "test" },
		{ type: "custom", id: "keep", parentId: null, timestamp, customType: "test" },
		{ type: "label", id: "label", parentId: "keep", timestamp, targetId: "drop", label: "mistake" },
		{ type: "label", id: "label2", parentId: "label", timestamp, targetId: "drop", label: undefined },
		{ type: "custom", id: "child", parentId: "label2", timestamp, customType: "test" },
		{ type: "label", id: "root-label", parentId: null, timestamp, targetId: "drop", label: "mistake" },
		{ type: "custom", id: "root-child", parentId: "root-label", timestamp, customType: "test" },
	];
	const original = structuredClone(entries);
	assert.deepEqual(
		removeEntrySubtree(entries, "drop").map(({ id, parentId }) => ({ id, parentId })),
		[
			{ id: "keep", parentId: null },
			{ id: "child", parentId: "keep" },
			{ id: "root-child", parentId: null },
		],
	);
	assert.deepEqual(entries, original);
});

test("atomic session rewrites preserve file permissions", () => {
	const sessionFile = createSessionFile("old\n");
	chmodSync(sessionFile, 0o600);

	rewriteSessionInPlace(sessionFile, "new\n");

	assert.equal(readFileSync(sessionFile, "utf-8"), "new\n");
	assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
});

test("restores the original session when replacement is cancelled", async () => {
	const sessionFile = createSessionFile("original\n");
	const replaced = await rewriteSessionForReplacement(sessionFile, "rewritten\n", async () => ({ cancelled: true }));

	assert.equal(replaced, false);
	assert.equal(readFileSync(sessionFile, "utf-8"), "original\n");
});

test("restores the original session when replacement throws", async () => {
	const sessionFile = createSessionFile("original\n");
	await assert.rejects(
		rewriteSessionForReplacement(sessionFile, "rewritten\n", async () => {
			throw new Error("replacement failed");
		}),
		/replacement failed/,
	);
	assert.equal(readFileSync(sessionFile, "utf-8"), "original\n");
});
