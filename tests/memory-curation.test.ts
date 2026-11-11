/**
 * The curation service (server/memory-curation.ts, plan 2026-11-10 task 14):
 * a pass runs only when due, applies in one sync block against the fresh
 * record, advances the cursor, logs usage once; a failed pass changes
 * nothing but the usage log. Isolated LH_DATA_DIR; app imports are dynamic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type ToolCall } from "@earendil-works/pi-ai";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-memory-curation-"));
process.env.LH_DATA_DIR = TMP;

const { curateChat } = await import("../src/server/memory-curation.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { memoryStore } = await import("../src/store/memory.ts");
const { emptyMemoryFile, memoryStatus } = await import("../src/core/memory.ts");
const { CURATOR_SUBMIT_TOOL } = await import("../src/agent/subagents/memory-curator.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => memoryStore.write(emptyMemoryFile()));

function engine(steps: FauxResponseFactory[]) {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const submit = (value: unknown) => () => fauxAssistantMessage([fauxToolCall(CURATOR_SUBMIT_TOOL, value as ToolCall["arguments"], { id: "s1" })], { stopReason: "toolUse" });

/** A practice chat with one concluded problem (a milestone). */
function practiceChat(): { id: string; messages: LhMessage[] } {
	const c = chatStore.createChat("Projectiles", "practice");
	const messages = [
		{ id: "m_sub", role: "toolResult", toolCallId: "ms", toolName: "memory_subject", isError: false, timestamp: 1, content: [], details: { subject: "Physics" } },
		{ id: "a0", role: "assistant", timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { statement: "s", modelSolution: "m" } }] },
		{ id: "r0", role: "toolResult", toolCallId: "p1", toolName: "problem", isError: false, timestamp: 1, content: [], details: {} },
		{ id: "t0", role: "custom", customType: "practice-thinking", content: "Your thinking:\nv = 0 so a = 0", display: true, details: { problemCallId: "p1", text: "v = 0 so a = 0" }, timestamp: 1 },
		{ id: "a1", role: "assistant", timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "unsolved", verdict: "a = g" } }] },
		{ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "conclude", isError: false, timestamp: 1, content: [], details: {} },
	] as unknown as LhMessage[];
	chatStore.saveMessages(c.id, messages);
	return { id: c.id, messages };
}
const NEW = { op: "new", kind: "mistake", area: "Kinematics", newAreaDescription: "Motion", text: "Sets a = 0 where v = 0.", evidence: [{ ref: "t0", note: "said a = 0 at rest" }] };

describe("the curation service", () => {
	it("not due: no model call, nothing changes", async () => {
		const c = chatStore.createChat("Empty");
		chatStore.saveMessages(c.id, [{ id: "u0", role: "user", content: "hi", timestamp: 1 } as never]);
		let built = false;
		assert.equal(await curateChat(c.id, { engine: () => { built = true; return null; } }), "not-due");
		assert.equal(built, false);
		assert.deepEqual(memoryStore.read(), emptyMemoryFile());
	});

	it("due: applies the submit, advances the cursor, logs usage once; then it is no longer due", async () => {
		const { id } = practiceChat();
		assert.equal(await curateChat(id, { engine: () => engine([submit({ subject: "Physics", newSubject: true, ops: [NEW] })]) }), "done");
		const file = memoryStore.read();
		assert.equal(file.memories.length, 1);
		assert.equal(memoryStatus(file.memories[0]!), "note");
		assert.equal(file.memories[0]!.entries[0]!.question, "p1");
		assert.equal(file.cursors?.[id], "r1");
		assert.equal(chatStore.getChat(id)!.curations?.length, 1);
		assert.equal(chatStore.getChat(id)!.curations![0]!.ops, 1);
		assert.equal(await curateChat(id, { engine: () => assert.fail("not due") }), "not-due");
	});

	it("an unreadable memory.json: skipped, never overwritten", async () => {
		const { id } = practiceChat();
		const file = path.join(TMP, "memory", "memory.json");
		fs.writeFileSync(file, "{broken");
		assert.equal(await curateChat(id, { engine: () => assert.fail("no model call") }), "skipped");
		assert.equal(fs.readFileSync(file, "utf-8"), "{broken");
		memoryStore.write(emptyMemoryFile());
	});

	it("no model configured: skipped, cursor unchanged", async () => {
		const { id } = practiceChat();
		assert.equal(await curateChat(id, { engine: () => null }), "skipped");
		assert.equal(memoryStore.read().cursors?.[id], undefined);
	});

	it("a failed pass leaves the cursor and the store unchanged but logs its usage", async () => {
		const { id } = practiceChat();
		const never = () => fauxAssistantMessage([{ type: "text", text: "no" }], { stopReason: "stop" });
		assert.equal(await curateChat(id, { engine: () => engine([never]) }), "failed");
		assert.deepEqual(memoryStore.read(), emptyMemoryFile());
		assert.equal(chatStore.getChat(id)!.curations?.length, 1);
		assert.equal(chatStore.getChat(id)!.curations![0]!.ops, undefined);
		// No retry at the next settle; the next milestone retries from the old cursor.
		assert.equal(await curateChat(id, { engine: () => assert.fail("waits for a milestone") }), "not-due");
		const record = chatStore.getChat(id)!;
		chatStore.saveMessages(id, [
			...record.messages,
			{ id: "a2", role: "assistant", timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "c2", name: "conclude", arguments: { outcome: "solved" } }] },
			{ id: "r2", role: "toolResult", toolCallId: "c2", toolName: "conclude", isError: false, timestamp: 1, content: [], details: {} },
		] as never);
		assert.equal(await curateChat(id, { engine: () => engine([submit({ subject: "Physics", newSubject: true, ops: [NEW] })]) }), "done");
		assert.equal(memoryStore.read().memories[0]!.entries[0]!.source!.ref, "t0");
	});

	it("ops citing messages removed mid-pass (Undo) are dropped", async () => {
		const { id, messages } = practiceChat();
		const undoThenSubmit: FauxResponseFactory = () => {
			chatStore.saveMessages(id, messages.slice(0, 3));
			return fauxAssistantMessage([fauxToolCall(CURATOR_SUBMIT_TOOL, { subject: "Physics", newSubject: true, ops: [NEW] } as never, { id: "s1" })], { stopReason: "toolUse" });
		};
		assert.equal(await curateChat(id, { engine: () => engine([undoThenSubmit]) }), "done");
		const file = memoryStore.read();
		assert.equal(file.memories.length, 0);
		assert.equal(file.cursors?.[id], "r0");
	});
});
