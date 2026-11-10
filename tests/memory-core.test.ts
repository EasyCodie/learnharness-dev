/**
 * Learner memory rules (core/memory.ts, plan 2026-11-10 task 1): pure, no IO.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PROFILE_CAP,
	applyRemember,
	emptyMemoryFile,
	memoryPromptBlock,
	memoryText,
	memoryView,
	reconcileWithChat,
	resolveName,
	sessionSubject,
	subjectIndex,
	type RememberInput,
	type RememberContext,
} from "../src/core/memory.ts";
import type { MemoryFile } from "../src/core/contracts/memory.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const at = "2026-11-10T10:00:00.000Z";
const agent = (ref: string, chatId = "chat_a") => ({ at, by: "agent" as const, source: { chatId, ref } });
const learner = { at, by: "learner" as const };

function save(file: MemoryFile, input: Partial<RememberInput>, ctx: RememberContext = agent("call_1")): MemoryFile {
	const result = applyRemember(file, { text: "Wants a diagram first.", kind: "preference", level: "profile", note: "he said so", ...input }, ctx);
	if ("problems" in result) throw new Error(result.problems.join("\n"));
	return result.file;
}
function problems(file: MemoryFile, input: Partial<RememberInput>): string {
	const result = applyRemember(file, { text: "x", kind: "preference", level: "profile", note: "n", ...input }, agent("call_x"));
	assert.ok("problems" in result, "expected a refusal");
	return result.problems.join("\n");
}

const call = (id: string, callIds: string[]) =>
	({ id, role: "assistant", timestamp: 1, content: callIds.map((c) => ({ type: "toolCall", id: c, name: "remember", arguments: {} })) }) as unknown as LhMessage;
const subjectResult = (id: string, subject: string, isError = false) =>
	({ id, role: "toolResult", toolCallId: `${id}-c`, toolName: "memory_subject", content: [], details: { subject }, isError, timestamp: 1 }) as unknown as LhMessage;

describe("memory core", () => {
	it("memoryText is the last entry that carries text", () => {
		let file = save(emptyMemoryFile(), { text: "first" });
		const id = file.memories[0]!.id;
		file = save(file, { text: "second", replaces: id }, agent("call_2"));
		assert.equal(memoryText(file.memories[0]!), "second");
		assert.equal(file.memories.length, 1);
	});

	it("resolveName: exact case-insensitive match only", () => {
		assert.equal(resolveName(["Economics"], " economics "), "Economics");
		assert.equal(resolveName(["Economics"], "econ"), null);
	});

	it("sessionSubject: the last successful memory_subject result", () => {
		assert.equal(sessionSubject([]), null);
		assert.equal(sessionSubject([subjectResult("r1", "Physics"), subjectResult("r2", "Maths"), subjectResult("r3", "Bad", true)]), "Maths");
	});

	it("subject and area levels need a subject; area level needs an area; area only with level area", () => {
		assert.match(problems(emptyMemoryFile(), { level: "subject" }), /memory_subject/);
		assert.match(problems(emptyMemoryFile(), { level: "area", subject: "Physics", newSubject: true }), /area is required/);
		assert.match(problems(emptyMemoryFile(), { level: "subject", subject: "Physics", newSubject: true, area: "Waves" }), /only used when level is "area"/);
	});

	it("an unknown subject is refused unless the caller marks it new", () => {
		const file = save(emptyMemoryFile(), { level: "subject", subject: "Economics", newSubject: true });
		assert.match(problems(file, { level: "subject", subject: "Econ" }), /Existing subjects: Economics/);
		const again = save(file, { level: "subject", subject: "economics" }, agent("c2"));
		assert.deepEqual(again.memories.map((m) => m.subject), ["Economics", "Economics"]);
	});

	it("an unknown area needs newAreaDescription, which is stored", () => {
		const base = save(emptyMemoryFile(), { level: "subject", subject: "Physics", newSubject: true });
		assert.match(problems(base, { level: "area", subject: "Physics", area: "Waves" }), /newAreaDescription/);
		const file = save(base, { level: "area", subject: "Physics", area: "Waves", newAreaDescription: "Interference, standing waves" }, agent("c2"));
		assert.deepEqual(file.areas, { Physics: { Waves: "Interference, standing waves" } });
	});

	it("duplicate guard: refuses once with the area's same-kind memories, passes with confirmNew", () => {
		const file = save(emptyMemoryFile(), { level: "area", subject: "Physics", newSubject: true, area: "Waves", newAreaDescription: "d", text: "Likes animations." });
		const refusal = problems(file, { level: "area", subject: "Physics", area: "waves" });
		assert.match(refusal, /Likes animations/);
		const ok = applyRemember(file, { text: "Likes sketches.", kind: "preference", level: "area", subject: "Physics", area: "Waves", confirmNew: true, note: "n" }, agent("c3"));
		assert.ok(!("problems" in ok));
		// A different kind in the same area is not a duplicate candidate.
		assert.ok(!("problems" in applyRemember(file, { text: "Goal: a 7.", kind: "knowledge", level: "area", subject: "Physics", area: "Waves", note: "n" }, agent("c4"))));
	});

	it("the 16th Profile save is refused with the list", () => {
		let file = emptyMemoryFile();
		for (let i = 0; i < PROFILE_CAP; i++) file = save(file, { text: `pref ${i}` }, agent(`c${i}`));
		assert.match(problems(file, { text: "one more" }), /Profile is full \(15 of 15\)[\s\S]*pref 0/);
		// A replacement still works at the cap.
		save(file, { text: "pref 0 revised", replaces: file.memories[0]!.id }, agent("c99"));
	});

	it("replaces must name an existing memory", () => {
		assert.match(problems(emptyMemoryFile(), { replaces: "m_nope00" }), /no memory has the id/);
	});

	it("reconcile: replaces then reconcile restores the previous wording", () => {
		let file = save(emptyMemoryFile(), { text: "old" }, agent("call_1"));
		file = save(file, { text: "new", replaces: file.memories[0]!.id }, agent("call_2"));
		const { file: after, removed } = reconcileWithChat(file, "chat_a", [call("a1", ["call_1"])]);
		assert.equal(memoryText(after.memories[0]!), "old");
		assert.equal(removed, 0);
	});

	it("reconcile: deletes a memory whose only entry is gone and prunes its area", () => {
		const file = save(emptyMemoryFile(), { level: "area", subject: "Physics", newSubject: true, area: "Waves", newAreaDescription: "d" }, agent("call_1"));
		const { file: after, removed } = reconcileWithChat(file, "chat_a", [call("a1", ["call_other"])]);
		assert.equal(removed, 1);
		assert.deepEqual(after, { version: 1, memories: [], areas: {} });
	});

	it("reconcile: Settings entries and other chats' entries are untouched", () => {
		let file = save(emptyMemoryFile(), { text: "from settings" }, learner);
		file = save(file, { text: "from chat b" }, agent("call_b", "chat_b"));
		const result = reconcileWithChat(file, "chat_a", []);
		assert.equal(result.changed, false);
		assert.equal(result.file.memories.length, 2);
	});

	it("subjectIndex lists subject-level memories, then areas with descriptions", () => {
		let file = save(emptyMemoryFile(), { level: "subject", subject: "Economics", newSubject: true, text: "Aiming for a 7." });
		file = save(file, { level: "area", subject: "Economics", area: "Unit 4 – Macroeconomics", newAreaDescription: "AD/AS, multipliers" }, agent("c2"));
		const index = subjectIndex(file, "Economics");
		assert.match(index, /^- \[m_[0-9a-z]{6}\] \(preference\) Aiming for a 7\.\nAreas \(open with memory_read\):\n- Unit 4 – Macroeconomics: AD\/AS, multipliers$/);
		assert.equal(subjectIndex(file, "Physics"), "New subject, no memories yet.");
	});

	it("the prompt block: doctrine, Profile count, subjects, session subject", () => {
		const file = save(emptyMemoryFile(), { text: "Wants a diagram before any algebra." });
		const block = memoryPromptBlock(file, null, "teacher");
		assert.match(block, /^## Memory\n/);
		assert.match(block, /ask him with `ask_user_question`/);
		assert.match(block, /### Profile \(1 of 15\)\n- \[m_\w+\] \(preference\) Wants a diagram before any algebra\./);
		assert.match(block, /### Subjects\nNone yet\./);
		assert.match(block, /### This session's subject: not set\. Call memory_subject once it is clear\.$/);
		assert.match(memoryPromptBlock(file, "Physics", "practice"), /ask him in one plain sentence[\s\S]*### This session's subject: Physics\nNew subject, no memories yet\.$/);
	});

	it("memoryView resolves each evidence state", () => {
		let file = save(emptyMemoryFile(), { text: "a" }, agent("call_1", "chat_live"));
		file = save(file, { text: "b" }, agent("call_2", "chat_gone"));
		file = save(file, { text: "c" }, learner);
		const view = memoryView(file, true, ({ chatId, ref }) => (chatId === "chat_live" ? { chatId, chatTitle: "Waves", messageId: `msg-${ref}` } : "deleted"));
		assert.deepEqual(view.profile.map((m) => m.evidence[0]!.where), [{ chatId: "chat_live", chatTitle: "Waves", messageId: "msg-call_1" }, "deleted", "settings"]);
	});
});
