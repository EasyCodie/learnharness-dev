/**
 * The memory curator agent (agent/subagents/memory-curator.ts, plan
 * 2026-11-10 task 13): faux engine, the extraction tests' pattern. The
 * submit is validated by core applyCuratorOps; a refusal returns to the
 * curator for a retry.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { CURATOR_SUBMIT_TOOL, runMemoryCurator, type CuratorRunInput } from "../src/agent/subagents/memory-curator.ts";
import { applyCuratorOps, emptyMemoryFile } from "../src/core/memory.ts";
import type { MemoryFile } from "../src/core/contracts/memory.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

function engine(steps: FauxResponseStep[], prompts: string[] = [], results: string[] = []): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map((step) => (context) => {
			const first = context.messages.find((m) => m.role === "user") as { content: unknown };
			prompts.push(typeof first.content === "string" ? first.content : JSON.stringify(first.content));
			const last = context.messages.at(-1) as { role: string; content: { text?: string }[] };
			if (last.role === "toolResult") results.push(last.content.map((c) => c.text ?? "").join(""));
			return typeof step === "function" ? step(context, undefined, { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] }, faux.getModel()) : step;
		}),
	);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}
const submit = (value: unknown, id = "s1") => fauxAssistantMessage([fauxToolCall(CURATOR_SUBMIT_TOOL, value as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

const thought = "the acceleration is zero at the top because the ball stops there";
const session: LhMessage[] = [
	{ id: "u0", role: "user", content: "teach me projectiles", timestamp: 1 },
	{ id: "a0", role: "assistant", timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "q0", name: "quiz", arguments: {} }] },
	{ id: "r0", role: "toolResult", toolCallId: "q0", toolName: "quiz", isError: false, timestamp: 1, content: [{ type: "text", text: "ok" }], details: { kind: "quiz", questionText: "Acceleration at the top?", answers: [{ index: 1, label: "zero" }], correct: false, thinking: thought, answeredAt: "x" } },
] as unknown as LhMessage[];

const other = (file: MemoryFile): MemoryFile => file;
function base(extra: Partial<CuratorRunInput> = {}): CuratorRunInput {
	return { chatId: "chat_c", kind: "teach", messages: session, spanStart: 1, readFile: () => emptyMemoryFile(), sessionSubject: "Physics", engine: undefined, ...extra };
}
const NEW = { op: "new", kind: "mistake", area: "Kinematics", newAreaDescription: "Motion", text: "Thinks a = 0 when v = 0.", evidence: [{ ref: "r0", note: "chose zero" }] };

describe("the memory curator", () => {
	it("a valid submit is returned and applies", async () => {
		const value = { subject: "Physics", newSubject: true, ops: [NEW] };
		const out = await runMemoryCurator(base({ engine: engine([submit(value)]) }));
		const applied = applyCuratorOps(emptyMemoryFile(), out, { chatId: "chat_c", messages: session, span: new Set(["a0", "r0"]), sessionSubject: "Physics", at: "2026-11-11T00:00:00.000Z" });
		assert.ok(!("problems" in applied));
		assert.equal(applied.file.memories[0]!.entries[0]!.question, "q0");
	});

	it("a refused submit returns the problems for a retry", async () => {
		const results: string[] = [];
		const bad = { subject: "Physics", newSubject: true, ops: [{ ...NEW, evidence: [{ ref: "u0", note: "outside the span" }] }] };
		const good = { subject: "Physics", newSubject: true, ops: [NEW] };
		const out = await runMemoryCurator(base({ engine: engine([submit(bad, "s1"), submit(good, "s2")], [], results) }));
		assert.equal(out.ops.length, 1);
		assert.match(results[0]!, /u0 is not a message id/);
	});

	it("a fabricated quote on a flawed model is refused and nothing is accepted", async () => {
		const results: string[] = [];
		const fabricated = { subject: "Physics", newSubject: true, ops: [{ op: "new", kind: "thinking", flawed: true, area: "K", newAreaDescription: "d", text: "t", evidence: [{ ref: "r0", note: "n", quote: "objects at rest have no acceleration at all" }] }] };
		await assert.rejects(runMemoryCurator(base({ engine: engine([submit(fabricated, "s1"), submit(fabricated, "s2"), submit(fabricated, "s3"), submit(fabricated, "s4"), submit(fabricated, "s5"), submit(fabricated, "s6")], [], results) })), /never submitted/);
		assert.match(results[0]!, /does not appear in his text/);
	});

	it("a new thinking memory without a mark is returned for retry", async () => {
		const results: string[] = [];
		const unmarked = { subject: "Physics", newSubject: true, ops: [{ ...NEW, kind: "thinking" }] };
		await runMemoryCurator(base({ engine: engine([submit(unmarked, "s1"), submit({ subject: "Physics", ops: [] }, "s2")], [], results) }));
		assert.match(results[0]!, /flawed: true/);
	});

	it("a span with nothing worth saving submits no ops", async () => {
		const out = await runMemoryCurator(base({ engine: engine([submit({ subject: "Physics", ops: [] })]) }));
		assert.deepEqual(out.ops, []);
	});

	it("the input shows the span with ids, his thinking, and other subjects' loaded mistake patterns only", async () => {
		const prompts: string[] = [];
		const curator = (ref: string, text?: string) => ({ at: "2026-11-01T00:00:00.000Z", by: "curator" as const, source: { chatId: "chat_m", ref }, note: "n", stance: "confirm" as const, question: ref, subject: "Maths", ...(text ? { text } : {}) });
		const file: MemoryFile = {
			version: 1,
			areas: { Maths: { Algebra: "a" } },
			memories: [
				{ id: "m_mist01", kind: "mistake", subject: "Maths", area: "Algebra", entries: [curator("x1", "SHOWN_PATTERN"), curator("x2")] },
				{ id: "m_note01", kind: "mistake", subject: "Maths", area: "Algebra", entries: [curator("x1", "HIDDEN_NOTE")] },
				{ id: "m_know01", kind: "knowledge", subject: "Maths", area: "Algebra", entries: [curator("x1", "HIDDEN_KNOWLEDGE"), curator("x2")] },
				{ id: "m_sound1", kind: "thinking", flawed: false, subject: "Maths", area: "Algebra", entries: [curator("x1", "HIDDEN_SOUND"), curator("x2")] },
			],
		};
		await runMemoryCurator(base({ readFile: () => file, engine: engine([submit({ subject: "Physics", newSubject: true, ops: [] })], prompts) }));
		const prompt = prompts[0]!;
		assert.match(prompt, /### Quiz · r0/);
		assert.match(prompt, /his thinking: the acceleration is zero at the top/);
		assert.doesNotMatch(prompt, /teach me projectiles/, "only the uncurated span");
		assert.match(prompt, /SHOWN_PATTERN/);
		assert.doesNotMatch(prompt, /HIDDEN_/);
		assert.match(prompt, /Physics, which holds no memories yet\. Other subjects exist: Maths/);
		assert.match(prompt, /### Profile \(0 of 15\)/);
	});

	it("a sighting on another subject's pattern followed by promote applies in one submit", async () => {
		const maths = (ref: string, text?: string) => ({ at: "2026-11-01T00:00:00.000Z", by: "curator" as const, source: { chatId: "chat_m", ref }, note: "n", stance: "confirm" as const, question: ref, subject: "Maths", ...(text ? { text } : {}) });
		const file: MemoryFile = { version: 1, areas: { Maths: { Algebra: "a" } }, memories: [{ id: "m_mist01", kind: "mistake", subject: "Maths", area: "Algebra", entries: [maths("x1", "Drops signs."), maths("x2")] }] };
		const two: LhMessage[] = [
			...session,
			{ id: "a1", role: "assistant", timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: {} }] },
			{ id: "r1", role: "toolResult", toolCallId: "q1", toolName: "quiz", isError: false, timestamp: 1, content: [], details: { kind: "quiz", questionText: "Q", correct: false, answeredAt: "x" } },
		] as unknown as LhMessage[];
		const value = {
			subject: "Physics",
			newSubject: true,
			ops: [
				{ op: "sighting", id: "m_mist01", stance: "confirm", evidence: [{ ref: "r0", note: "sign" }] },
				{ op: "promote", ids: ["m_mist01"], text: "Drops minus signs.", evidence: [{ ref: "r1", note: "sign again" }] },
			],
		};
		const out = await runMemoryCurator(base({ messages: two, readFile: () => file, engine: engine([submit(value)]) }));
		const applied = applyCuratorOps(file, out, { chatId: "chat_c", messages: two, span: new Set(two.slice(1).map((m) => m.id)), sessionSubject: "Physics", at: "2026-11-11T00:00:00.000Z" });
		assert.ok(!("problems" in applied), JSON.stringify(applied));
		assert.equal(other(applied.file).memories[0]!.subject, undefined);
	});
});
