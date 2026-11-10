/**
 * The learner-memory fs adapter (src/store/memory.ts): absent file reads
 * empty, round trip, and a corrupt or newer file is refused and never
 * overwritten.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-memory-store-"));
process.env.LH_DATA_DIR = TMP;

const { memoryStore } = await import("../src/store/memory.ts");
const { MemoryUnavailableError, emptyMemoryFile } = await import("../src/core/memory.ts");
const { MEMORY_FILE } = await import("../config.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("memory store", () => {
	it("an absent file reads as empty", () => {
		assert.deepEqual(memoryStore.read(), emptyMemoryFile());
	});

	it("round trip, creating the directory", () => {
		const file = { version: 1 as const, memories: [{ id: "m_abc123", kind: "preference" as const, entries: [{ at: "t", by: "learner" as const, note: "n", stance: "confirm" as const, text: "x" }] }], areas: {} };
		memoryStore.write(file);
		assert.deepEqual(memoryStore.read(), file);
	});

	it("corrupt JSON and a newer format are refused and left untouched", () => {
		for (const bytes of ["{not json", JSON.stringify({ version: 2, memories: [], areas: {} }), JSON.stringify({ version: 1 })]) {
			fs.writeFileSync(MEMORY_FILE, bytes);
			assert.throws(() => memoryStore.read(), MemoryUnavailableError);
			assert.equal(fs.readFileSync(MEMORY_FILE, "utf-8"), bytes);
		}
	});
});
