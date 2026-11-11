/**
 * Learner memory Phase 2 core (plan 2026-11-10 task 11): sightings, status,
 * the curator's ops, cross-subject promotion, notices — and the high bar for
 * flawed thinking models. Pure, no IO.
 *
 * THE FLAWED-MODEL TESTS GUARD THE STRICTEST RULE IN THE SYSTEM (plan section
 * "The high bar for flawed thinking models"). None of them may be weakened to
 * make another test pass.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FLAWED_MIN_QUESTIONS,
	FLAWED_MIN_SESSIONS,
	FLAWED_MIN_QUOTE_CHARS,
	PROFILE_CAP,
	applyCuratorOps,
	applyRemember,
	areaContents,
	curationDue,
	curatorMemoryText,
	emptyMemoryFile,
	learnerTextOf,
	memoryNoticesFor,
	memoryPromptBlock,
	memoryStatus,
	memoryText,
	questionKeyOf,
	reconcileWithChat,
	subjectIndex,
	type CuratorContext,
	type CuratorOp,
	type CuratorSubmit,
} from "../src/core/memory.ts";
import type { Memory, MemoryFile } from "../src/core/contracts/memory.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// ── transcript builders ─────────────────────────────────────────────────────

const assistant = (id: string, calls: { id: string; name: string; args?: Record<string, unknown> }[], text?: string) =>
	({
		id,
		role: "assistant",
		timestamp: 1,
		stopReason: calls.length ? "toolUse" : "stop",
		content: [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} }))],
	}) as unknown as LhMessage;
const result = (id: string, callId: string, toolName: string, details: Record<string, unknown> = {}, isError = false) =>
	({ id, role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 1 }) as unknown as LhMessage;
const user = (id: string, text: string) => ({ id, role: "user", content: text, timestamp: 1 }) as unknown as LhMessage;
const thinking = (id: string, problemCallId: string, text: string) =>
	({ id, role: "custom", customType: "practice-thinking", content: `Your thinking:\n${text}`, display: true, details: { problemCallId, text }, timestamp: 1 }) as unknown as LhMessage;

const FAULTY = "the acceleration is zero at the top because the ball stops there";
const FAULTY2 = "since it is not moving at the top, no force acts on it there";

/** A teaching session: one answered quiz per check, each with his thinking. */
function teaching(prefix: string, thoughts: string[]): LhMessage[] {
	const out: LhMessage[] = [];
	thoughts.forEach((t, i) => {
		const call = `${prefix}_q${i}`;
		out.push(assistant(`${prefix}_a${i}`, [{ id: call, name: "quiz" }], "Here is a check."));
		out.push(result(`${prefix}_r${i}`, call, "quiz", { kind: "quiz", questionText: "What is the acceleration at the top of the flight?", answers: [{ index: 1, label: "g, downwards" }], correct: true, thinking: t, answeredAt: "x" }));
	});
	return out;
}

const AT = "2026-11-11T10:00:00.000Z";
function ctx(chatId: string, messages: LhMessage[], extra: Partial<CuratorContext> = {}): CuratorContext {
	return { chatId, messages, span: new Set(messages.map((m) => m.id)), sessionSubject: "Physics", at: AT, ...extra };
}
function apply(file: MemoryFile, c: CuratorContext, ops: CuratorOp[], subject = "Physics", newSubject = true): MemoryFile {
	const r = applyCuratorOps(file, { subject, newSubject, ops }, c);
	if ("problems" in r) throw new Error(r.problems.join("\n"));
	return r.file;
}
function refuse(file: MemoryFile, c: CuratorContext, ops: CuratorOp[], subject = "Physics", newSubject = true): string {
	const r = applyCuratorOps(file, { subject, newSubject, ops }, c);
	assert.ok("problems" in r, "expected a refusal");
	return r.problems.join("\n");
}
const only = (file: MemoryFile): Memory => {
	assert.equal(file.memories.length, 1);
	return file.memories[0]!;
};
const ev = (ref: string, quote?: string) => ({ ref, note: "he did it", ...(quote ? { quote } : {}) });

// ── ordinary sightings (Default 21) ─────────────────────────────────────────

describe("memory status from sightings", () => {
	const s = teaching("s1", ["a", "b", "c", "d", "e"]);
	const c = ctx("chat_1", s);
	const first = apply(emptyMemoryFile(), c, [{ op: "new", kind: "mistake", area: "Kinematics", newAreaDescription: "Motion", text: "Drops the sign of g.", evidence: [ev("s1_r0")] }]);
	const id = only(first).id;

	it("one sighting is a note; a second on a different question makes it active", () => {
		assert.equal(memoryStatus(only(first)), "note");
		assert.equal(memoryStatus(only(apply(first, c, [{ op: "sighting", id, stance: "confirm", evidence: [ev("s1_r1")] }]))), "active");
	});

	it("a second sighting on the same question counts once", () => {
		const twice = apply(first, c, [{ op: "sighting", id, stance: "confirm", evidence: [ev("s1_r0")] }]);
		assert.equal(memoryStatus(only(twice)), "note");
	});

	it("fading at one contradiction since the last confirmation, faded at two, revived by a confirmation", () => {
		let f = apply(first, c, [{ op: "sighting", id, stance: "confirm", evidence: [ev("s1_r1")] }]);
		f = apply(f, c, [{ op: "sighting", id, stance: "contradict", evidence: [ev("s1_r2")] }]);
		assert.equal(memoryStatus(only(f)), "fading");
		f = apply(f, c, [{ op: "sighting", id, stance: "contradict", evidence: [ev("s1_r3")] }]);
		assert.equal(memoryStatus(only(f)), "faded");
		f = apply(f, c, [{ op: "sighting", id, stance: "confirm", evidence: [ev("s1_r4")] }]);
		assert.equal(memoryStatus(only(f)), "active");
	});

	it("an entry from Ivan keeps a memory active", () => {
		const m = only(first);
		const withIvan: Memory = { ...m, entries: [...m.entries, { at: AT, by: "learner", note: "Edited by you in Settings", stance: "confirm", text: "x" }] };
		assert.equal(memoryStatus(withIvan), "active");
	});

	it("notes, faded memories and areas holding only them are hidden from the tutor", () => {
		assert.doesNotMatch(subjectIndex(first, "Physics"), /Kinematics|Drops the sign/);
		assert.equal(areaContents(first, "Physics", "Kinematics"), "");
		assert.doesNotMatch(memoryPromptBlock(first, "Physics", "prober"), /Drops the sign/);
		// The subject name stays visible so it is reused (Default 61).
		assert.match(memoryPromptBlock(first, null, "teacher"), /### Subjects\nPhysics/);
	});

	it("the duplicate guard, the unknown-area refusal and the Profile-full refusal never print hidden memories or areas", () => {
		const ctxA = { at: AT, by: "agent" as const, source: { chatId: "chat_1", ref: "c" } };
		const r = applyRemember(first, { text: "x", kind: "mistake", level: "area", subject: "Physics", area: "Kinematics", note: "n" }, ctxA);
		assert.ok(!("problems" in r), "no visible same-kind memory → no refusal");
		const unknown = applyRemember(first, { text: "x", kind: "preference", level: "area", subject: "Physics", area: "Optics", note: "n" }, ctxA);
		assert.ok("problems" in unknown);
		assert.doesNotMatch(unknown.problems.join(), /Kinematics/);
		// A full Profile holding a promoted pattern that has since faded.
		let full: MemoryFile = { ...first, memories: [...first.memories, { id: "m_faded0", kind: "mistake", entries: [
			{ at: AT, by: "curator", source: { chatId: "c", ref: "x1" }, note: "n", stance: "confirm", question: "x1", subject: "A", text: "SENTINEL_FADED" },
			{ at: AT, by: "curator", source: { chatId: "c", ref: "x2" }, note: "n", stance: "confirm", question: "x2", subject: "A" },
			{ at: AT, by: "curator", source: { chatId: "c", ref: "x3" }, note: "n", stance: "contradict", question: "x3", subject: "A" },
			{ at: AT, by: "curator", source: { chatId: "c", ref: "x4" }, note: "n", stance: "contradict", question: "x4", subject: "A" },
		] }] };
		for (let i = 0; i < PROFILE_CAP - 1; i++) {
			const added = applyRemember(full, { text: `p${i}`, kind: "preference", level: "profile", note: "n" }, { at: AT, by: "learner" });
			assert.ok(!("problems" in added));
			full = added.file;
		}
		const refusal = applyRemember(full, { text: "one more", kind: "preference", level: "profile", note: "n" }, ctxA);
		assert.ok("problems" in refusal);
		assert.match(refusal.problems.join(), /Profile is full \(15 of 15\)/);
		assert.doesNotMatch(refusal.problems.join(), /SENTINEL_FADED/);
	});
});

// ── question identity (Defaults 54, 55) ─────────────────────────────────────

describe("questionKeyOf", () => {
	const practice: LhMessage[] = [
		assistant("p_a0", [{ id: "prob1", name: "problem", args: { statement: "s", modelSolution: "m" } }]),
		result("p_r0", "prob1", "problem"),
		thinking("p_t0", "prob1", "first try"),
		thinking("p_t1", "prob1", "second try"),
		assistant("p_a1", [{ id: "conc1", name: "conclude", args: { outcome: "solved", verdict: "v" } }]),
		result("p_r1", "conc1", "conclude"),
		user("p_u0", "why was that right?"),
		assistant("p_a2", [], "Because."),
	];
	it("a problem's result, its thinking submissions, its conclusion and a follow-up share one key", () => {
		for (const id of ["p_r0", "p_t0", "p_t1", "p_r1", "p_u0"]) assert.equal(questionKeyOf(practice, id), "prob1", id);
	});
	it("a typed message with no check before it is its own question; a tutor message is no evidence", () => {
		assert.equal(questionKeyOf([user("u0", "hi")], "u0"), "u0");
		assert.equal(questionKeyOf(practice, "p_a2"), null);
		assert.equal(questionKeyOf(teaching("t", ["x"]), "t_r0"), "t_q0");
	});
	it("learnerTextOf: his words only", () => {
		const s = teaching("t", ["my reasoning here"]);
		assert.equal(learnerTextOf(s[1]!), "my reasoning here");
		assert.doesNotMatch(learnerTextOf(s[1]!), /acceleration at the top/);
		assert.equal(learnerTextOf(practice[2]!), "first try");
		assert.equal(learnerTextOf(practice[5]!), "");
		assert.equal(learnerTextOf(practice[1]!), "");
	});
});

// ── curationDue (Default 27) ────────────────────────────────────────────────

describe("curationDue", () => {
	it("five answered teaching checks after the cursor, not four", () => {
		const s = teaching("c", ["1", "2", "3", "4", "5"]);
		assert.equal(curationDue(s, undefined), true);
		assert.equal(curationDue(s.slice(0, 8), undefined), false);
		assert.equal(curationDue(s, "c_r0"), false);
	});
	it("a concluded probe or problem; a dismissed problem or check is not a milestone", () => {
		const probe = [assistant("a", [{ id: "pd", name: "probe_done" }]), result("r", "pd", "probe_done", { ok: true })];
		assert.equal(curationDue(probe, undefined), true);
		const concluded = [assistant("a", [{ id: "cc", name: "conclude", args: { outcome: "solved" } }]), result("r", "cc", "conclude")];
		assert.equal(curationDue(concluded, undefined), true);
		const dismissed = [assistant("a", [{ id: "cd", name: "conclude", args: { outcome: "dismissed" } }]), result("r", "cd", "conclude")];
		assert.equal(curationDue(dismissed, undefined), false);
		const skipped = teaching("d", ["1", "2", "3", "4", "5"]).map((m) => (m.role === "toolResult" && m.id === "d_r4" ? { ...m, details: { dismissed: true } } : m)) as LhMessage[];
		assert.equal(curationDue(skipped, undefined), false);
	});
});

// ── curator op validation (task 13 checks that live in core) ───────────────

describe("applyCuratorOps validation", () => {
	const s = teaching("v", ["a", "b"]);
	const c = ctx("chat_v", s);
	it("refs must be in the span; tutor messages are refused; no preference kind; thinking needs a mark", () => {
		assert.match(refuse(emptyMemoryFile(), c, [{ op: "new", kind: "mistake", area: "K", newAreaDescription: "d", text: "t", evidence: [ev("nope")] }]), /nope/);
		assert.match(refuse(emptyMemoryFile(), c, [{ op: "new", kind: "mistake", area: "K", newAreaDescription: "d", text: "t", evidence: [ev("v_a0")] }]), /tutor/);
		assert.match(refuse(emptyMemoryFile(), c, [{ op: "new", kind: "preference" as never, area: "K", newAreaDescription: "d", text: "t", evidence: [ev("v_r0")] }]), /preference/);
		assert.match(refuse(emptyMemoryFile(), c, [{ op: "new", kind: "thinking", area: "K", newAreaDescription: "d", text: "t", evidence: [ev("v_r0")] }]), /flawed/);
		assert.match(refuse(emptyMemoryFile(), c, [{ op: "new", kind: "mistake", area: "K", text: "t", evidence: [ev("v_r0")] }]), /newAreaDescription/);
	});
	it("an empty op list is a valid result and changes nothing", () => {
		const file = emptyMemoryFile();
		assert.deepEqual(apply(file, c, []), file);
	});
	it("the curator files under the session subject (Default 60)", () => {
		const physics = apply(emptyMemoryFile(), c, [{ op: "new", kind: "mistake", area: "K", newAreaDescription: "d", text: "t", evidence: [ev("v_r0")] }]);
		assert.match(refuse(physics, c, [{ op: "new", kind: "mistake", area: "K", text: "u", evidence: [ev("v_r1")] }], "Maths"), /Physics/);
		// Session subject holds no memories, others exist: reuse one, or confirm the session's subject as new.
		const other = ctx("chat_w", s, { sessionSubject: "Mechanics" });
		assert.match(refuse(physics, other, [{ op: "new", kind: "mistake", area: "K", text: "u", evidence: [ev("v_r1")] }], "Mechanics", false), /Physics/);
		assert.equal(apply(physics, other, [{ op: "sighting", id: physics.memories[0]!.id, stance: "confirm", evidence: [ev("v_r1")] }], "physics", false).memories.length, 1);
		assert.equal(apply(physics, other, [{ op: "new", kind: "mistake", area: "K", newAreaDescription: "d", text: "u", evidence: [ev("v_r1")] }], "Mechanics", true).memories[1]!.subject, "Mechanics");
	});
	it("a new thinking memory keeps its mark; a revision cannot change it", () => {
		const f = apply(emptyMemoryFile(), c, [{ op: "new", kind: "thinking", flawed: false, area: "K", newAreaDescription: "d", text: "Reasons from forces.", evidence: [ev("v_r0")] }]);
		assert.equal(only(f).flawed, false);
		const revised = apply(f, c, [{ op: "revise", id: only(f).id, text: "Reasons from net force.", evidence: [ev("v_r1")] }]);
		assert.equal(only(revised).flawed, false);
		assert.equal(memoryText(only(revised)), "Reasons from net force.");
	});
});

// ── notices (Default 25) ────────────────────────────────────────────────────

describe("memoryNoticesFor", () => {
	const s = teaching("n", ["a", "b", "c", "d"]);
	const c = ctx("chat_n", s);
	const note = apply(emptyMemoryFile(), c, [{ op: "new", kind: "mistake", area: "K", newAreaDescription: "d", text: "Drops the sign.", evidence: [ev("n_r0")] }]);
	const id = only(note).id;
	const active = apply(note, c, [{ op: "sighting", id, stance: "confirm", evidence: [ev("n_r1")] }]);
	it("a note has no notice; the sighting that makes it active does, in that chat only", () => {
		assert.deepEqual(memoryNoticesFor(note, "chat_n"), []);
		assert.deepEqual(memoryNoticesFor(active, "chat_n"), [{ memoryId: id, text: "Drops the sign.", ref: "n_r1" }]);
		assert.deepEqual(memoryNoticesFor(active, "chat_other"), []);
	});
	it("the notice disappears when the memory fades out or is undone", () => {
		const faded = apply(active, c, [{ op: "sighting", id, stance: "contradict", evidence: [ev("n_r2"), ev("n_r3")] }]);
		assert.equal(memoryStatus(only(faded)), "faded");
		assert.deepEqual(memoryNoticesFor(faded, "chat_n"), []);
		const undone = reconcileWithChat(active, "chat_n", s.slice(0, 2)).file;
		assert.deepEqual(memoryNoticesFor(undone, "chat_n"), []);
	});
	it("reconcile resets a cursor whose message is gone to the last remaining message", () => {
		const withCursor: MemoryFile = { ...active, cursors: { chat_n: "n_r3" } };
		assert.equal(reconcileWithChat(withCursor, "chat_n", s.slice(0, 4)).file.cursors?.chat_n, "n_r1");
		assert.equal(reconcileWithChat(withCursor, "chat_n", s).changed, false);
	});
});

// ── cross-subject promotion (Defaults 29–34) ────────────────────────────────

describe("promotion to the Profile", () => {
	const phys = teaching("ph", ["a", "b", "c"]);
	const maths = teaching("ma", ["a", "b", "c"]);
	const cp = ctx("chat_ph", phys);
	const cm = ctx("chat_ma", maths, { sessionSubject: "Maths" });
	const inPhysics = apply(emptyMemoryFile(), cp, [{ op: "new", kind: "mistake", area: "Kinematics", newAreaDescription: "Motion", text: "Drops minus signs when rearranging.", evidence: [ev("ph_r0"), ev("ph_r1")] }]);
	const pid = only(inPhysics).id;

	it("2 + 2 sightings promote into one Profile memory with all evidence and no copy", () => {
		const f = apply(inPhysics, cm, [
			{ op: "sighting", id: pid, stance: "confirm", evidence: [ev("ma_r0")] },
			{ op: "promote", ids: [pid], text: "Drops minus signs when rearranging equations.", evidence: [ev("ma_r1")] },
		], "Maths", true);
		const m = only(f);
		assert.equal(m.subject, undefined);
		assert.equal(m.entries.length, 4);
		assert.deepEqual(m.entries.at(-1)!.promotedFrom, { subject: "Physics", area: "Kinematics", areaDescription: "Motion" });
		assert.deepEqual(f.areas, {});
		assert.deepEqual(memoryNoticesFor(f, "chat_ma"), [{ memoryId: m.id, text: "Drops minus signs when rearranging equations.", ref: "ma_r1" }]);
	});

	it("2 + 1 is refused with what is missing, and the pattern stays where it is", () => {
		const msg = refuse(inPhysics, cm, [{ op: "promote", ids: [pid], text: "x", evidence: [ev("ma_r0")] }], "Maths", true);
		assert.match(msg, /Maths has 1/);
	});

	it("two reactions to one question do not count twice", () => {
		assert.match(refuse(inPhysics, cm, [{ op: "promote", ids: [pid], text: "x", evidence: [ev("ma_r0"), ev("ma_r0")] }], "Maths", true), /Maths has 1/);
	});

	it("a full Profile refuses; a memory Ivan placed by hand is refused", () => {
		let full = apply(inPhysics, cm, [{ op: "sighting", id: pid, stance: "confirm", evidence: [ev("ma_r0")] }], "Maths", true);
		for (let i = 0; i < PROFILE_CAP; i++) {
			const r = applyRemember(full, { text: `p${i}`, kind: "preference", level: "profile", note: "n" }, { at: AT, by: "learner" });
			assert.ok(!("problems" in r));
			full = r.file;
		}
		assert.match(refuse(full, cm, [{ op: "promote", ids: [pid], text: "x", evidence: [ev("ma_r1")] }], "Maths", true), /Profile is full/);
		const placed: MemoryFile = { ...inPhysics, memories: inPhysics.memories.map((m) => ({ ...m, placedByLearner: true })) };
		assert.match(refuse(placed, cm, [{ op: "sighting", id: pid, stance: "confirm", evidence: [ev("ma_r0")] }, { op: "promote", ids: [pid], text: "x", evidence: [ev("ma_r1")] }], "Maths", true), /placed/);
	});

	it("Undo below the bar files it back where it was, with the earlier wording", () => {
		const promoted = apply(inPhysics, cm, [
			{ op: "sighting", id: pid, stance: "confirm", evidence: [ev("ma_r0")] },
			{ op: "promote", ids: [pid], text: "Drops minus signs when rearranging equations.", evidence: [ev("ma_r1")] },
		], "Maths", true);
		const back = reconcileWithChat(promoted, "chat_ma", maths.slice(0, 2)).file;
		const m = only(back);
		assert.equal(m.subject, "Physics");
		assert.equal(m.area, "Kinematics");
		assert.equal(memoryText(m), "Drops minus signs when rearranging.");
		assert.deepEqual(back.areas, { Physics: { Kinematics: "Motion" } });
	});

	it("the curator sees each pattern's sightings by subject", () => {
		const withMaths = apply(inPhysics, cm, [{ op: "sighting", id: pid, stance: "confirm", evidence: [ev("ma_r0")] }], "Maths", true);
		assert.match(curatorMemoryText(withMaths, "Maths"), /Physics › Kinematics; mistake; active; sightings by subject: Physics 2 questions, Maths 1 question\) Drops minus signs/);
		const twice = apply(withMaths, cm, [{ op: "sighting", id: pid, stance: "confirm", evidence: [ev("ma_r1")] }], "Maths", true);
		assert.match(curatorMemoryText(twice, "Maths"), /Physics 2 questions, Maths 2 questions; meets the Profile bar\)/);
		const placed: MemoryFile = { ...twice, memories: twice.memories.map((m) => ({ ...m, placedByLearner: true })) };
		assert.match(curatorMemoryText(placed, "Maths"), /Maths 2 questions; placed by him in Settings, never promoted\)/);
	});

	it("other subjects' notes are not offered for cross-subject sightings", () => {
		const note = apply(emptyMemoryFile(), cp, [{ op: "new", kind: "mistake", area: "K", newAreaDescription: "d", text: "t", evidence: [ev("ph_r0")] }]);
		assert.match(refuse(note, cm, [{ op: "sighting", id: only(note).id, stance: "confirm", evidence: [ev("ma_r0")] }], "Maths", true), /not shown/);
	});
});

// ── THE HIGH BAR FOR FLAWED THINKING MODELS (Defaults 35–41, 54–57) ─────────
// Guard tests. Do not weaken.

describe("flawed thinking models: the high bar", () => {
	it("the bar's constants are 3 questions, 2 sessions, 20-character quotes", () => {
		assert.equal(FLAWED_MIN_QUESTIONS, 3);
		assert.equal(FLAWED_MIN_SESSIONS, 2);
		assert.equal(FLAWED_MIN_QUOTE_CHARS, 20);
	});

	const s1 = teaching("f1", [FAULTY, FAULTY, FAULTY, "sound: the net force at the top is still mg, so a = g"]);
	const s2 = teaching("f2", [FAULTY, FAULTY, FAULTY]);
	const c1 = ctx("chat_f1", s1);
	const c2 = ctx("chat_f2", s2);
	const quote = "acceleration is zero at the top";
	const born = apply(emptyMemoryFile(), c1, [{ op: "new", kind: "thinking", flawed: true, area: "Kinematics", newAreaDescription: "Motion", text: "Treats momentary rest as zero acceleration.", evidence: [ev("f1_r0", quote)] }]);
	const id = only(born).id;
	const see = (file: MemoryFile, c: CuratorContext, ref: string) => apply(file, c, [{ op: "sighting", id, stance: "confirm", evidence: [ev(ref, quote)] }]);

	it("2 sightings stay unconfirmed", () => {
		assert.equal(memoryStatus(only(see(born, c1, "f1_r1"))), "unconfirmed");
	});

	it("3 sightings in one session stay unconfirmed", () => {
		assert.equal(memoryStatus(only(see(see(born, c1, "f1_r1"), c1, "f1_r2"))), "unconfirmed");
	});

	it("3 sightings on 3 questions over 2 sessions activate", () => {
		assert.equal(memoryStatus(only(see(see(born, c1, "f1_r1"), c2, "f2_r0"))), "active");
	});

	it("3 sightings where two share a question stay unconfirmed", () => {
		const shared = see(see(born, c1, "f1_r0"), c2, "f2_r0");
		assert.equal(memoryStatus(only(shared)), "unconfirmed");
	});

	it("in practice, two thinking submissions on one problem are one question", () => {
		const practice: LhMessage[] = [
			assistant("pp_a0", [{ id: "pp1", name: "problem" }]),
			result("pp_r0", "pp1", "problem"),
			thinking("pp_t0", "pp1", FAULTY),
			thinking("pp_t1", "pp1", FAULTY2 + " and " + FAULTY),
		];
		const cp = ctx("chat_pp", practice);
		const f = apply(born, cp, [{ op: "sighting", id, stance: "confirm", evidence: [ev("pp_t0", quote), ev("pp_t1", quote)] }]);
		assert.equal(memoryStatus(only(f)), "unconfirmed");
	});

	it("one contradiction resets it; 2 further sightings do not reactivate it, a third does", () => {
		let f = see(see(born, c1, "f1_r1"), c2, "f2_r0");
		assert.equal(memoryStatus(only(f)), "active");
		f = apply(f, c1, [{ op: "sighting", id, stance: "contradict", evidence: [ev("f1_r3")] }]);
		assert.equal(memoryStatus(only(f)), "unconfirmed");
		f = see(see(f, c2, "f2_r1"), c2, "f2_r2");
		assert.equal(memoryStatus(only(f)), "unconfirmed");
		f = see(f, c1, "f1_r2");
		assert.equal(memoryStatus(only(f)), "active");
	});

	it("a contradiction needs no quote but must cite his own message (Default 57)", () => {
		const practice: LhMessage[] = [
			assistant("pq_a0", [{ id: "pq1", name: "problem" }]),
			result("pq_r0", "pq1", "problem"),
			assistant("pq_a1", [{ id: "pqc", name: "conclude", args: { outcome: "solved" } }]),
			result("pq_r1", "pqc", "conclude"),
		];
		assert.match(refuse(born, ctx("chat_pq", practice), [{ op: "sighting", id, stance: "contradict", evidence: [ev("pq_r1")] }]), /his own/);
		assert.equal(memoryStatus(only(apply(born, c1, [{ op: "sighting", id, stance: "contradict", evidence: [ev("f1_r3")] }]))), "unconfirmed");
	});

	it("a quote absent from the cited message is refused", () => {
		assert.match(refuse(born, c1, [{ op: "sighting", id, stance: "confirm", evidence: [ev("f1_r1", "the ball has no acceleration anywhere")] }]), /does not appear/);
	});

	it("a quote taken from the tutor's text in that message is refused", () => {
		assert.match(refuse(born, c1, [{ op: "sighting", id, stance: "confirm", evidence: [ev("f1_r1", "What is the acceleration at the top")] }]), /does not appear/);
	});

	it("a sighting citing a tutor message is refused", () => {
		assert.match(refuse(born, c1, [{ op: "sighting", id, stance: "confirm", evidence: [ev("f1_a1", quote)] }]), /tutor/);
	});

	it("a quote under 20 characters is refused; a missing quote is refused", () => {
		assert.match(refuse(born, c1, [{ op: "sighting", id, stance: "confirm", evidence: [ev("f1_r1", "zero at the top")] }]), /20/);
		assert.match(refuse(born, c1, [{ op: "sighting", id, stance: "confirm", evidence: [ev("f1_r1")] }]), /quote/);
		assert.match(refuse(emptyMemoryFile(), c1, [{ op: "new", kind: "thinking", flawed: true, area: "K", newAreaDescription: "d", text: "t", evidence: [ev("f1_r0")] }]), /quote/);
	});

	it("the quote check ignores case and whitespace differences only", () => {
		assert.equal(memoryStatus(only(see(born, c1, "f1_r1"))), "unconfirmed");
		apply(born, c1, [{ op: "sighting", id, stance: "confirm", evidence: [ev("f1_r1", "  ACCELERATION   is zero\nat the top ")] }]);
	});

	it("an unconfirmed model appears in no agent prompt, no area read and no notice", () => {
		const f = see(see(born, c1, "f1_r1"), c1, "f1_r2");
		for (const kind of ["prober", "teacher", "practice"] as const) assert.doesNotMatch(memoryPromptBlock(f, "Physics", kind), /momentary rest|Kinematics/);
		assert.equal(areaContents(f, "Physics", "Kinematics"), "");
		assert.deepEqual(memoryNoticesFor(f, "chat_f1"), []);
	});

	it("an active flawed model is labelled flawed for the tutor; a sound one sound", () => {
		const f = see(see(born, c1, "f1_r1"), c2, "f2_r0");
		assert.match(areaContents(f, "Physics", "Kinematics"), /flawed/);
		const sound = apply(emptyMemoryFile(), c1, [{ op: "new", kind: "thinking", flawed: false, area: "K", newAreaDescription: "d", text: "Reasons from net force.", evidence: [ev("f1_r3")] }]);
		const soundActive = apply(sound, c2, [{ op: "sighting", id: only(sound).id, stance: "confirm", evidence: [ev("f2_r0")] }]);
		assert.match(areaContents(soundActive, "Physics", "K"), /sound/);
	});

	it("Ivan rewording it keeps it on the bar; Ivan setting the mark himself makes it his statement (Default 56)", () => {
		const m = only(born);
		const reworded: Memory = { ...m, entries: [...m.entries, { at: AT, by: "learner", note: "Edited by you in Settings", stance: "confirm", text: "x" }] };
		assert.equal(memoryStatus(reworded), "unconfirmed");
		const replaced: Memory = { ...m, entries: [...m.entries, { at: AT, by: "agent", source: { chatId: "c", ref: "r" }, note: "n", stance: "confirm", text: "x" }] };
		assert.equal(memoryStatus(replaced), "unconfirmed");
		assert.equal(memoryStatus({ ...m, markedByLearner: true }), "active");
		const own: Memory = { id: "m_own000", kind: "thinking", flawed: true, subject: "Physics", entries: [{ at: AT, by: "learner", note: "Added by you in Settings", stance: "confirm", text: "x" }] };
		assert.equal(memoryStatus(own), "active");
	});

	it("cross-subject promotion of a flawed model needs 3 questions over 2 sessions in each subject", () => {
		const m1 = teaching("g1", [FAULTY, FAULTY]);
		const m2 = teaching("g2", [FAULTY, FAULTY]);
		const cm1 = ctx("chat_g1", m1, { sessionSubject: "Maths" });
		const cm2 = ctx("chat_g2", m2, { sessionSubject: "Maths" });
		// Physics: 3 questions over 2 sessions → active, so Maths may see it.
		const active = see(see(born, c1, "f1_r1"), c2, "f2_r0");
		let f = apply(active, cm1, [{ op: "sighting", id, stance: "confirm", evidence: [ev("g1_r0", quote), ev("g1_r1", quote)] }], "Maths", true);
		// Maths: 2 questions in 1 session — not enough.
		assert.match(refuse(f, cm1, [{ op: "promote", ids: [id], text: "Treats momentary rest as zero acceleration.", evidence: [ev("g1_r1", quote)] }], "Maths", true), /Maths/);
		// Maths: 3 questions over 2 sessions — promoted.
		f = apply(f, cm2, [{ op: "promote", ids: [id], text: "Treats momentary rest as zero acceleration.", evidence: [ev("g2_r0", quote)] }], "Maths", true);
		assert.equal(only(f).subject, undefined);
		assert.equal(only(f).flawed, true);
	});

	it("a promotion never mixes mistake patterns and flawed models", () => {
		const active = see(see(born, c1, "f1_r1"), c2, "f2_r0");
		const mixed = apply(active, c1, [{ op: "new", kind: "mistake", area: "Kinematics", text: "Drops signs.", evidence: [ev("f1_r1")] }]);
		const mid = mixed.memories.find((m) => m.kind === "mistake")!.id;
		assert.match(refuse(mixed, c1, [{ op: "promote", ids: [id, mid], text: "x", evidence: [ev("f1_r2", quote)] }]), /mix/);
	});
});

// ── agents use the new memories (task 16) ──────────────────────────────────

describe("the prompt block in Phase 2", () => {
	const s = teaching("k", ["a", "b", "c"]);
	const c = ctx("chat_k", s);
	let file = apply(emptyMemoryFile(), c, [
		{ op: "new", kind: "knowledge", area: "Kinematics", newAreaDescription: "Motion", text: "Holds the range formula, not its derivation.", evidence: [ev("k_r0"), ev("k_r1")] },
		{ op: "new", kind: "mistake", area: "Kinematics", text: "Drops the sign of g.", evidence: [ev("k_r0"), ev("k_r1"), ev("k_r2")] },
	]);
	file = { ...file, memories: file.memories.map((m) => (m.kind === "knowledge" ? { ...m, entries: m.entries.map((e) => ({ ...e, at: "2026-09-01T00:00:00.000Z" })) } : m)) };
	const now = new Date("2026-11-11T12:00:00.000Z");

	it("the prober's block lists knowledge memories with their date, old past 30 days", () => {
		const block = memoryPromptBlock(file, "Physics", "prober", now);
		assert.match(block, /### Knowledge memories for Physics\n- \[m_\w+\] \(knowledge; as of 2026-09-01, old\) Holds the range formula, not its derivation\. \[Kinematics\]/);
		assert.match(block, /\*\*Prober\.\*\* Knowledge memories for this subject are an earlier measurement of his edge\./);
		assert.doesNotMatch(memoryPromptBlock(file, "Physics", "teacher", now), /### Knowledge memories/);
	});

	it("the doctrine covers everything he can see, the probe assessment included (Ivan, 2026-11-11)", () => {
		for (const kind of ["prober", "teacher", "practice"] as const) {
			assert.match(memoryPromptBlock(file, "Physics", kind, now), /never mention this section\. This holds for everything he can see, including the probe assessment and any summary: describe what this session shows, never what a memory says\. Do not report that a remembered mistake or way of thinking did not appear, and call something a repeat only when both times are in this session\./);
		}
	});

	it("the prober records a flawed model only when his thinking shows it (Default 82)", () => {
		const block = memoryPromptBlock(file, "Physics", "prober", now);
		assert.match(block, /give different answers\. If his thinking shows the flawed model, record that in the assessment\. If it does not, write nothing about it, in the assessment or in any message to him, and do not mention the wrong options you set to test it\./);
		assert.doesNotMatch(block, /and record what his thinking shows/);
	});

	it("practice names a remembered mistake only as it happened here; a repeat only within the session (Default 81)", () => {
		const block = memoryPromptBlock(file, "Physics", "practice", now);
		assert.match(block, /name the mistake in your verdict as it happened in this problem, and do not say it has happened before\. If he makes the same mistake a second time in this session, you may say it is the same one as earlier in the session\./);
		assert.match(block, /name it only when his thinking trace in this session shows it\./);
		assert.doesNotMatch(block, /name the pattern in your verdict/);
	});

	it("each agent kind gets its own role paragraph, and the What to save sentence points after the session", () => {
		assert.match(memoryPromptBlock(file, "Physics", "teacher", now), /\*\*Teacher\.\*\* Plan and present with his preferences/);
		assert.match(memoryPromptBlock(file, "Physics", "practice", now), /\*\*Practice\.\*\* Choose problems that exercise his recorded mistake patterns/);
		assert.doesNotMatch(memoryPromptBlock(file, "Physics", "practice", now), /\*\*Teacher\.\*\*|\*\*Prober\.\*\*/);
		assert.match(memoryPromptBlock(file, null, "teacher", now), /how you think he reasons; that is recorded after the session\./);
	});

	it("area contents carry the strength line", () => {
		assert.match(areaContents(file, "Physics", "Kinematics", now), /\(mistake; seen 3×, last 2026-11-11\) Drops the sign of g\./);
	});
});

describe("submit shape", () => {
	it("CuratorSubmit is a plain object", () => {
		const submit: CuratorSubmit = { subject: "Physics", ops: [] };
		assert.equal(submit.ops.length, 0);
	});
});
