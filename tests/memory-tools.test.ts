/**
 * The learner-memory tools (agent/tools/memory.ts, plan 2026-11-10 task 4):
 * refusals and their retry paths, the turn-scoped subject, and registration
 * in all three agents' registries.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryTools, type MemoryToolContext } from "../src/agent/tools/memory.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import { emptyMemoryFile, memoryText } from "../src/core/memory.ts";
import type { MemoryFile } from "../src/core/contracts/memory.ts";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

function harness(messages: LhMessage[] = [], initial: MemoryFile = emptyMemoryFile()) {
	let file = initial;
	let changes = 0;
	const ctx: MemoryToolContext = {
		chatId: "chat_t",
		chatStore: { getChat: () => ({ messages }) as never },
		memoryStore: { read: () => file, write: (next) => { file = next; } },
		onChange: () => { changes++; },
	};
	const tools = memoryTools(ctx);
	const run = (name: string, input: unknown, id = "call_1") => tools[name]!.execute(id, input as never, undefined);
	const text = async (name: string, input: unknown, id?: string) => ((await run(name, input, id)).content[0] as { text: string }).text;
	return { run, text, file: () => file, changes: () => changes };
}

const pref = (extra: object = {}) => ({ text: "Wants a diagram before any algebra.", kind: "preference", level: "profile", note: "He asked for pictures first.", ...extra });

describe("memory tools", () => {
	it("remember saves with the call id as evidence and notifies", async () => {
		const h = harness();
		const result = await h.run("remember", pref(), "toolu_1");
		assert.deepEqual((result.details as { ok: boolean }).ok, true);
		const m = h.file().memories[0]!;
		assert.deepEqual(m.entries[0]!.source, { chatId: "chat_t", ref: "toolu_1" });
		assert.equal(h.changes(), 1);
	});

	it("memory_subject refuses an unknown name once, then accepts an existing name or new: true", async () => {
		const h = harness();
		await h.run("remember", { ...pref(), level: "subject" }).then(() => assert.fail("needs a subject"), (e: Error) => assert.match(e.message, /memory_subject/));
		await assert.rejects(h.run("memory_subject", { subject: "Economics" }), /Existing subjects: none[\s\S]*new: true/);
		assert.equal(await h.text("memory_subject", { subject: "Economics", new: true }), "New subject, no memories yet.");
		// Same run: the subject is shared with remember through the closure.
		await h.run("remember", { ...pref(), level: "subject", text: "Aiming for a 7." }, "c2");
		assert.equal(h.file().memories[0]!.subject, "Economics");
		await assert.rejects(h.run("memory_subject", { subject: "Econ" }), /Existing subjects: Economics/);
		assert.match(await h.text("memory_subject", { subject: "economics" }), /Aiming for a 7\./);
	});

	it("a second memory_subject switches the subject", async () => {
		const h = harness();
		await h.run("memory_subject", { subject: "Physics", new: true });
		await h.run("memory_subject", { subject: "Maths", new: true });
		await h.run("remember", { ...pref(), level: "subject" });
		assert.equal(h.file().memories[0]!.subject, "Maths");
	});

	it("the subject is seeded from the saved record", async () => {
		const record = [{ id: "r1", role: "toolResult", toolCallId: "x", toolName: "memory_subject", content: [], details: { subject: "Physics" }, isError: false, timestamp: 1 }] as unknown as LhMessage[];
		const h = harness(record);
		await h.run("remember", { ...pref(), level: "subject" });
		assert.equal(h.file().memories[0]!.subject, "Physics");
	});

	it("a new subject set in an earlier turn is re-checked against the current list before the first save", async () => {
		const record = [{ id: "r1", role: "toolResult", toolCallId: "x", toolName: "memory_subject", content: [], details: { subject: "IB Physics HL" }, isError: false, timestamp: 1 }] as unknown as LhMessage[];
		const existing = harness();
		await existing.run("memory_subject", { subject: "Physics HL", new: true });
		await existing.run("remember", { ...pref(), level: "subject" });
		const h = harness(record, existing.file());
		await assert.rejects(h.run("remember", { ...pref(), level: "subject" }), /subject list has changed[\s\S]*Existing subjects: Physics HL/);
		assert.match(await h.text("memory_subject", { subject: "physics hl" }), /Wants a diagram/);
		await h.run("remember", { ...pref(), level: "subject", text: "Units in words." }, "c9");
		assert.deepEqual([...new Set(h.file().memories.map((m) => m.subject))], ["Physics HL"]);
		// Confirming the new name in this turn is accepted.
		const h2 = harness(record, existing.file());
		await h2.run("memory_subject", { subject: "IB Physics HL", new: true });
		await h2.run("remember", { ...pref(), level: "subject" });
		assert.ok(h2.file().memories.some((m) => m.subject === "IB Physics HL"));
		// Profile saves never need a subject.
		await harness(record, existing.file()).run("remember", pref());
	});

	it("memory_read: needs a subject, refuses an unknown area with the list, returns the area", async () => {
		const h = harness();
		await assert.rejects(h.run("memory_read", { area: "Waves" }), /memory_subject first/);
		await h.run("memory_subject", { subject: "Physics", new: true });
		await assert.rejects(h.run("remember", { ...pref(), level: "area", area: "Waves" }), /newAreaDescription/);
		await h.run("remember", { ...pref(), level: "area", area: "Waves", newAreaDescription: "Interference" });
		await assert.rejects(h.run("memory_read", { area: "Optics" }), /Areas: Waves/);
		assert.match(await h.text("memory_read", { area: "waves" }), /\(preference\) Wants a diagram/);
	});

	it("memory_read never shows notes or unconfirmed flawed models, nor an area holding only them", async () => {
		const curator = (ref: string, chatId = "chat_x") => ({ at: "2026-11-11T00:00:00.000Z", by: "curator" as const, source: { chatId, ref }, note: "n", stance: "confirm" as const, question: ref, subject: "Physics" });
		const file: MemoryFile = {
			version: 1,
			areas: { Physics: { Hidden: "only hidden", Shown: "has one loaded" } },
			memories: [
				{ id: "m_note00", kind: "mistake", subject: "Physics", area: "Hidden", entries: [{ ...curator("q1"), text: "SENTINEL_NOTE" }] },
				{ id: "m_flaw00", kind: "thinking", flawed: true, subject: "Physics", area: "Shown", entries: [{ ...curator("q1"), quote: "x", text: "SENTINEL_FLAWED" }, { ...curator("q2"), quote: "x" }, { ...curator("q3"), quote: "x" }] },
				{ id: "m_actv00", kind: "mistake", subject: "Physics", area: "Shown", entries: [{ ...curator("q1"), text: "Drops signs." }, curator("q2")] },
			],
		};
		const h = harness([], file);
		const index = await h.text("memory_subject", { subject: "Physics" });
		assert.doesNotMatch(index, /Hidden|SENTINEL/);
		assert.match(index, /Shown: has one loaded/);
		await assert.rejects(h.run("memory_read", { area: "Hidden" }), /Areas: Shown/);
		const shown = await h.text("memory_read", { area: "Shown" });
		assert.match(shown, /Drops signs\./);
		assert.doesNotMatch(shown, /SENTINEL/);
	});

	it("duplicate guard and replaces through the tool", async () => {
		const h = harness();
		await h.run("memory_subject", { subject: "Physics", new: true });
		await h.run("remember", { ...pref(), level: "area", area: "Waves", newAreaDescription: "d" }, "c1");
		await assert.rejects(h.run("remember", { ...pref(), level: "area", area: "Waves", text: "Likes sketches." }, "c2"), /confirmNew/);
		await h.run("remember", { ...pref(), level: "area", area: "Waves", text: "Likes sketches.", confirmNew: true }, "c3");
		const id = h.file().memories[0]!.id;
		await h.run("remember", { ...pref(), text: "Wants a sketch, then algebra.", replaces: id }, "c4");
		assert.equal(memoryText(h.file().memories[0]!), "Wants a sketch, then algebra.");
		assert.equal(h.file().memories.length, 2);
	});
});

describe("memory tools in the registries", () => {
	const chatStore = { getChat: () => ({ messages: [], tree: null }) } as unknown as ChatStore;
	const jobStore = { createJob: () => ({}), getJob: () => null, listJobs: () => [], updateJob: () => null } as unknown as JobStore;
	const memory: MemoryToolContext = { chatId: "c", chatStore, memoryStore: { read: emptyMemoryFile, write: () => {} }, onChange: () => {} };
	const names = ["memory_subject", "memory_read", "remember"];
	const has = (tools: Record<string, unknown>) => names.map((n) => n in tools);

	it("present with a memory context, absent without, for prober, teacher and practice", () => {
		const prober = { chatId: "c", chatStore, deliver: () => {}, jobStore, spawn: () => {} };
		const teacher = { chatId: "c", chatStore, jobStore, spawn: () => {} };
		const practice = { chatId: "c", chatStore };
		assert.deepEqual(has(createProberTools(prober)), [false, false, false]);
		assert.deepEqual(has(createProberTools({ ...prober, memory })), [true, true, true]);
		assert.deepEqual(has(createTeacherTools(teacher)), [false, false, false]);
		assert.deepEqual(has(createTeacherTools({ ...teacher, memory })), [true, true, true]);
		assert.deepEqual(has(practiceTools(practice)), [false, false, false]);
		assert.deepEqual(has(practiceTools({ ...practice, memory })), [true, true, true]);
	});

	it("tool toggles cannot drop them", () => {
		const off = Object.fromEntries(names.map((n) => [n, false]));
		assert.deepEqual(has(createTeacherTools({ chatId: "c", chatStore, jobStore, spawn: () => {}, memory }, off)), [true, true, true]);
	});
});
