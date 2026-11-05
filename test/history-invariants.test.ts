import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { removeEntrySubtree } from "../src/pi-wtf.ts";

// Fixed seeds make a failing tree reproducible without another test dependency.
for (let seed = 1; seed <= 100; seed++) {
	test(`subtree removal preserves tree invariants (seed ${seed})`, () => {
		let state = seed;
		const pick = (n: number) => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state % n;
		};
		const entries: SessionEntry[] = [];
		const targets: string[] = [];
		for (let i = 0; i < 100; i++) {
			const base = {
				id: `entry-${i}`, parentId: i === 0 || pick(8) === 0 ? null : entries[pick(i)].id,
				timestamp: "2026-01-01T00:00:00.000Z",
			};
			if (i > 0 && pick(4) === 0) {
				entries.push({ ...base, type: "label", targetId: targets[pick(targets.length)], label: `label-${i}` });
			} else {
				entries.push({ ...base, type: "custom", customType: "fixture", data: { index: i, nested: [seed] } });
				targets.push(base.id);
			}
		}
		const original = structuredClone(entries);
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		// Independent oracle: walk each entry's ancestors instead of traversing children.
		for (const rootId of targets) {
			const removed = new Set(entries.filter((entry) => {
				let ancestor: SessionEntry | undefined = entry;
				while (ancestor) {
					if (ancestor.id === rootId) return true;
					ancestor = ancestor.parentId === null ? undefined : byId.get(ancestor.parentId);
				}
				return false;
			}).map((entry) => entry.id));
			for (const entry of entries) {
				if (entry.type === "label" && removed.has(entry.targetId)) removed.add(entry.id);
			}
			const result = removeEntrySubtree(entries, rootId);
			const ids = new Set(result.map((entry) => entry.id));
			assert.deepEqual([...ids], entries.filter((entry) => !removed.has(entry.id)).map((entry) => entry.id));
			for (const entry of result) {
				assert.ok(entry.parentId === null || ids.has(entry.parentId));
				if (entry.type === "label") assert.ok(ids.has(entry.targetId));
				const before = byId.get(entry.id)!;
				let parentId = before.parentId;
				while (parentId !== null && removed.has(parentId)) parentId = byId.get(parentId)!.parentId;
				assert.deepEqual(entry, { ...before, parentId });
			}
		}
		assert.deepEqual(entries, original);
	});
}
