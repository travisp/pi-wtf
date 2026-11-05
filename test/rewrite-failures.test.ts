import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rewriteSessionForReplacement } from "../src/pi-wtf.ts";

for (const operation of ["writeFileSync", "renameSync"] as const) {
	test(`failed ${operation} preserves original bytes and cleans temporary files`, async (t) => {
		const directory = fs.mkdtempSync(join(tmpdir(), "pi-wtf-failure-"));
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		const file = join(directory, "session.jsonl");
		const original = Buffer.from("original session\n");
		fs.writeFileSync(file, original, { mode: 0o640 });
		const write = fs.writeFileSync;
		const failure = Object.assign(new Error(`injected ${operation} failure`), { code: "EIO" });
		const mock = t.mock.method(fs, operation, (...args: unknown[]) => {
			// A failed write may have already created and partially written the temp file.
			if (operation === "writeFileSync") write(args[0] as string, "partial");
			throw failure;
		});
		syncBuiltinESMExports();
		let reloadCalled = false;
		try {
			await assert.rejects(rewriteSessionForReplacement(file, "replacement\n", async () => {
				reloadCalled = true;
				return { cancelled: false };
			}), (error) => error === failure);
		} finally {
			mock.mock.restore();
			syncBuiltinESMExports();
		}
		assert.equal(reloadCalled, false);
		assert.deepEqual(fs.readFileSync(file), original);
		assert.equal(fs.statSync(file).mode & 0o777, 0o640);
		assert.deepEqual(fs.readdirSync(directory), ["session.jsonl"]);
	});
}
