/**
 * Learner memory rules (plan: docs/superpowers/plans/2026-11-10-learner-memory.md).
 * Pure: no IO. The store adapter reads/writes the file; the tools, the
 * Settings service and Undo call these.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, probeDoneResultIds, userFacingTextOf, type LhMarkerMessage, type LhMessage } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import type { Memory, MemoryEntry, MemoryEvidenceWhere, MemoryFile, MemoryKind, MemoryLevel, MemoryRow, MemoryStatus, MemoryView } from "./contracts/memory.ts";

export const PROFILE_CAP = 15;
export const MEMORY_KINDS: readonly MemoryKind[] = ["knowledge", "thinking", "mistake", "preference"];
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
	knowledge: "Knowledge",
	thinking: "Thinking model",
	mistake: "Mistake pattern",
	preference: "Preference / Goal",
};
export const MEMORY_TOOL_NAMES = ["memory_subject", "memory_read", "remember"] as const;

/** Thrown by the store when memory.json is corrupt or newer than this build. */
export class MemoryUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryUnavailableError";
	}
}

export function emptyMemoryFile(): MemoryFile {
	return { version: 1, memories: [], areas: {} };
}

/** Current wording: the last entry that has text. */
export function memoryText(m: Memory): string {
	for (let i = m.entries.length - 1; i >= 0; i--) {
		const text = m.entries[i]!.text;
		if (text !== undefined) return text;
	}
	return "";
}

// ─── status (Default 21; flawed thinking models: Defaults 35–41, 54–57) ─────

/** Confirming sightings on different questions that make a memory active. */
export const SIGHTINGS_TO_ACTIVATE = 2;
/** THE HIGH BAR FOR FLAWED THINKING MODELS — see the plan section of that name
 *  (docs/superpowers/plans/2026-11-10-learner-memory.md). The strictest rule
 *  in the system: never relax these numbers. */
export const FLAWED_MIN_QUESTIONS = 3;
export const FLAWED_MIN_SESSIONS = 2;
export const FLAWED_MIN_QUOTE_CHARS = 20;
/** Answered teaching checks between curator passes (Default 27). */
export const CHECKS_PER_CURATION = 5;
/** Knowledge older than this is labelled "old" to the agents (Default 22). */
export const KNOWLEDGE_OLD_DAYS = 30;

const questionOf = (e: MemoryEntry) => e.question ?? e.source?.ref ?? "";
const distinct = (values: string[]) => new Set(values).size;
const isFlawed = (m: Pick<Memory, "kind" | "flawed">) => m.kind === "thinking" && m.flawed === true;

/** A curator-created flawed model whose mark Ivan has not set himself: it
 *  is active only on the high bar (Ivan rewording it does not confirm it). */
function onFlawedBar(m: Memory): boolean {
	return isFlawed(m) && m.entries[0]?.by === "curator" && !m.markedByLearner;
}

/** Confirming curator sightings since the last contradicting one. */
function confirmsSinceContradiction(entries: readonly MemoryEntry[]): MemoryEntry[] {
	const curator = entries.filter((e) => e.by === "curator");
	let last = -1;
	curator.forEach((e, i) => { if (e.stance === "contradict") last = i; });
	return curator.slice(last + 1).filter((e) => e.stance === "confirm");
}

/** Questions and sessions counted toward the flawed bar (Default 36). */
export function flawedProgress(m: Pick<Memory, "entries">): { questions: number; sessions: number } {
	const confirms = confirmsSinceContradiction(m.entries);
	return { questions: distinct(confirms.map(questionOf)), sessions: distinct(confirms.map((e) => e.source?.chatId ?? "")) };
}

/** Derived on read, never stored (Default 21). */
export function memoryStatus(m: Memory): MemoryStatus {
	if (onFlawedBar(m)) {
		const { questions, sessions } = flawedProgress(m);
		return questions >= FLAWED_MIN_QUESTIONS && sessions >= FLAWED_MIN_SESSIONS ? "active" : "unconfirmed";
	}
	// Ivan's statement (a chat request, a Settings entry, or his own mark) is active.
	if (m.markedByLearner || m.entries.some((e) => e.by !== "curator")) return "active";
	const curator = m.entries.filter((e) => e.by === "curator");
	if (distinct(curator.filter((e) => e.stance === "confirm").map(questionOf)) < SIGHTINGS_TO_ACTIVATE) return "note";
	let lastConfirm = -1;
	curator.forEach((e, i) => { if (e.stance === "confirm") lastConfirm = i; });
	const contradictions = curator.slice(lastConfirm + 1).filter((e) => e.stance === "contradict").length;
	return contradictions === 0 ? "active" : contradictions === 1 ? "fading" : "faded";
}

/** Loaded for the conversation agents: active or fading. */
export function isLoaded(m: Memory): boolean {
	const status = memoryStatus(m);
	return status === "active" || status === "fading";
}

/** Trimmed, case-insensitive exact match → the existing spelling, else null. */
export function resolveName(existing: Iterable<string>, name: string): string | null {
	const want = name.trim().toLowerCase();
	for (const candidate of existing) if (candidate.toLowerCase() === want) return candidate;
	return null;
}

/** Subjects that hold at least one memory, sorted. */
export function subjectsOf(file: MemoryFile): string[] {
	return [...new Set(file.memories.flatMap((m) => (m.subject ? [m.subject] : [])))].sort((a, b) => a.localeCompare(b));
}

/** Areas of a subject that hold at least one memory, sorted. */
export function areasOf(file: MemoryFile, subject: string): string[] {
	return [...new Set(file.memories.flatMap((m) => (m.subject === subject && m.area ? [m.area] : [])))].sort((a, b) => a.localeCompare(b));
}

export function profileMemories(file: MemoryFile): Memory[] {
	return file.memories.filter((m) => !m.subject);
}

/** The subject of the last successful memory_subject call, else null. */
export function sessionSubject(messages: readonly LhMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "toolResult" || m.toolName !== "memory_subject" || m.isError) continue;
		const subject = (m.details as { subject?: unknown } | undefined)?.subject;
		if (typeof subject === "string" && subject) return subject;
	}
	return null;
}

/** Drop area descriptions (and subjects) that no longer hold a memory. */
export function pruneAreas(file: MemoryFile): MemoryFile {
	const areas: MemoryFile["areas"] = {};
	for (const [subject, byArea] of Object.entries(file.areas)) {
		for (const [area, description] of Object.entries(byArea)) {
			if (file.memories.some((m) => m.subject === subject && m.area === area)) (areas[subject] ??= {})[area] = description;
		}
	}
	return { ...file, areas };
}

export function newMemoryId(file: MemoryFile, random: () => number = Math.random): string {
	const taken = new Set(file.memories.map((m) => m.id));
	for (;;) {
		const id = `m_${Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0")}`;
		if (!taken.has(id)) return id;
	}
}

const day = (iso: string) => iso.slice(0, 10);

/** The strength and labels shown beside a memory to the agents. */
export function strengthLine(m: Memory, now: Date = new Date()): string {
	const labels: string[] = [];
	if (m.kind === "thinking" && m.flawed !== undefined) labels.push(m.flawed ? "flawed" : "sound");
	const sightings = m.entries.filter((e) => e.by === "curator" && e.stance === "confirm");
	if (m.kind === "knowledge") {
		const last = m.entries.at(-1)!.at;
		labels.push(`as of ${day(last)}`);
		if (now.getTime() - Date.parse(last) > KNOWLEDGE_OLD_DAYS * 86_400_000) labels.push("old");
	} else if (sightings.length > 0) {
		labels.push(`seen ${distinct(sightings.map(questionOf))}×, last ${day(sightings.at(-1)!.at)}`);
	}
	if (memoryStatus(m) === "fading") labels.push("fading");
	return labels.join(", ");
}

export function memoryLine(m: Memory, now?: Date): string {
	const strength = strengthLine(m, now);
	return `- [${m.id}] (${m.kind}${strength ? `; ${strength}` : ""}) ${memoryText(m)}`;
}

export interface RememberInput {
	text: string;
	kind: MemoryKind;
	level: MemoryLevel;
	/** Required for subject and area levels. */
	subject?: string | null;
	/** The caller accepts a subject name that matches no existing subject. */
	newSubject?: boolean;
	area?: string;
	newAreaDescription?: string;
	replaces?: string;
	confirmNew?: boolean;
	note: string;
}

export interface RememberContext {
	at: string;
	by: MemoryEntry["by"];
	source?: { chatId: string; ref: string };
}

export type RememberResult = { file: MemoryFile; memory: Memory } | { problems: string[] };

/** Validate and apply one save. Returns the new file, or the refusal reasons. */
export function applyRemember(file: MemoryFile, input: RememberInput, ctx: RememberContext): RememberResult {
	const text = input.text.trim();
	if (!text) return { problems: ["text must not be empty."] };
	const entry: MemoryEntry = { at: ctx.at, by: ctx.by, ...(ctx.source ? { source: ctx.source } : {}), note: input.note.trim(), stance: "confirm", text };

	// A replacement updates the wording in place; where it is filed stays.
	if (input.replaces) {
		const target = file.memories.find((m) => m.id === input.replaces);
		if (!target) return { problems: [`replaces: no memory has the id ${input.replaces}.`] };
		const memory = { ...target, entries: [...target.entries, entry] };
		return { file: { ...file, memories: file.memories.map((m) => (m.id === memory.id ? memory : m)) }, memory };
	}

	const place = resolvePlacement(file, input);
	if ("problems" in place) return place;
	const { subject, area, newArea } = place;

	if (input.level === "profile") {
		const profile = profileMemories(file);
		if (profile.length >= PROFILE_CAP) {
			// Only loaded memories are listed: hidden ones never reach an agent.
			return {
				problems: [
					`The Profile is full (${PROFILE_CAP} of ${PROFILE_CAP}). Replace one of these with replaces, or file the memory under a subject:\n${profile.filter(isLoaded).map((m) => memoryLine(m)).join("\n")}`,
				],
			};
		}
	}

	if (input.level === "area" && !newArea && !input.confirmNew) {
		const same = file.memories.filter((m) => m.subject === subject && m.area === area && m.kind === input.kind && isLoaded(m));
		if (same.length > 0) {
			return {
				problems: [
					`The area "${area}" already holds these ${input.kind} memories. If one already says this, do not save it again; if he changed one, save with replaces set to its id; if this is new, call again with confirmNew: true.\n${same.map((m) => memoryLine(m)).join("\n")}`,
				],
			};
		}
	}

	const memory: Memory = {
		id: newMemoryId(file),
		kind: input.kind,
		...(subject ? { subject } : {}),
		...(area ? { area } : {}),
		entries: [entry],
	};
	const areas = newArea ? { ...file.areas, [subject!]: { ...file.areas[subject!], [area!]: input.newAreaDescription!.trim() } } : file.areas;
	return { file: { ...file, memories: [...file.memories, memory], areas }, memory };
}

/** Resolve level/subject/area names for a new memory or a move. */
export function resolvePlacement(
	file: MemoryFile,
	input: Pick<RememberInput, "level" | "subject" | "newSubject" | "area" | "newAreaDescription">,
): { subject?: string; area?: string; newArea: boolean } | { problems: string[] } {
	if (input.level !== "area" && input.area?.trim()) return { problems: ['area is only used when level is "area".'] };
	if (input.level === "profile") return { newArea: false };
	if (!input.subject?.trim()) return { problems: ["Set the session's subject with memory_subject before saving at the subject or area level."] };
	const subjects = subjectsOf(file);
	const subject = resolveName(subjects, input.subject) ?? (input.newSubject ? input.subject.trim() : null);
	if (!subject) return { problems: [`No subject named "${input.subject.trim()}". Existing subjects: ${subjects.join(", ") || "none"}.`] };
	if (input.level === "subject") return { subject, newArea: false };
	if (!input.area?.trim()) return { problems: ["area is required when level is \"area\"."] };
	const areas = areasOf(file, subject);
	const area = resolveName(areas, input.area);
	if (area) return { subject, area, newArea: false };
	if (!input.newAreaDescription?.trim()) {
		return {
			problems: [
				`No area named "${input.area.trim()}" under ${subject}. Existing areas: ${areas.join(", ") || "none"}. Reuse one of them, or give newAreaDescription (one line saying what the area covers) to create it.`,
			],
		};
	}
	return { subject, area: input.area.trim(), newArea: true };
}

/** Every message id and tool-call id in a transcript. */
function transcriptRefs(messages: readonly LhMessage[]): Set<string> {
	const refs = new Set<string>();
	for (const m of messages) {
		refs.add(m.id);
		if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") refs.add(b.id);
		if (m.role === "toolResult") refs.add(m.toolCallId);
	}
	return refs;
}

/** A Profile memory the curator promoted goes back to where it was filed
 *  when its promotion entry is gone or the bar no longer holds (Default 34). */
function unpromote(m: Memory, before: Memory, areas: MemoryFile["areas"]): { memory: Memory; areas: MemoryFile["areas"] } {
	const promotion = before.entries.find((e) => e.promotedFrom);
	if (m.subject || m.placedByLearner || !promotion) return { memory: m, areas };
	if (m.entries.includes(promotion) && meetsProfileBar(m)) return { memory: m, areas };
	const from = promotion.promotedFrom!;
	const memory: Memory = { ...m, entries: m.entries.filter((e) => e !== promotion), subject: from.subject, ...(from.area ? { area: from.area } : {}) };
	if (!from.area || areas[from.subject]?.[from.area] !== undefined) return { memory, areas };
	return { memory, areas: { ...areas, [from.subject]: { ...areas[from.subject], [from.area]: from.areaDescription ?? "" } } };
}

/**
 * Drop this chat's entries whose source is no longer in its transcript
 * (Undo, a failed settle). A memory left without wording is deleted and
 * emptied areas are pruned; a promotion that loses its bar is reversed; a
 * curator cursor whose message is gone moves to the last remaining message.
 * Entries without a source, or from other chats, are never touched.
 */
export function reconcileWithChat(file: MemoryFile, chatId: string, messages: readonly LhMessage[]): { file: MemoryFile; removed: number; changed: boolean } {
	const refs = transcriptRefs(messages);
	let removed = 0;
	let changed = false;
	let areas = file.areas;
	const memories: Memory[] = [];
	for (const m of file.memories) {
		const entries = m.entries.filter((e) => e.source?.chatId !== chatId || refs.has(e.source.ref));
		if (entries.length === m.entries.length) {
			memories.push(m);
			continue;
		}
		changed = true;
		if (!entries.some((e) => e.text !== undefined)) {
			removed++;
			continue;
		}
		const back = unpromote({ ...m, entries }, m, areas);
		areas = back.areas;
		memories.push(back.memory);
	}
	let cursors = file.cursors;
	const cursor = cursors?.[chatId];
	if (cursor !== undefined && !refs.has(cursor)) {
		changed = true;
		const { [chatId]: _gone, ...rest } = cursors!;
		const last = messages.at(-1)?.id;
		cursors = last ? { ...rest, [chatId]: last } : rest;
	}
	if (!changed) return { file, removed, changed };
	return { file: pruneAreas({ ...file, memories, areas, ...(cursors ? { cursors } : {}) }), removed, changed };
}

// ─── the learner's evidence in a transcript (Defaults 37, 54, 55) ───────────

const QUESTION_TOOL_NAMES: readonly string[] = QUESTION_TOOLS;

/** The text he authored in a message: a typed message, his answer and
 *  thinking on a check, a practice thinking submission. Empty otherwise
 *  (tutor text, option labels, problem and conclude results). */
export function learnerTextOf(message: LhMessage): string {
	if (message.role === "user") return userFacingTextOf(message.content).join("\n");
	if (message.role === "custom") return message.customType === "practice-thinking" ? String((message.details as { text?: unknown } | null)?.text ?? "") : "";
	if (message.role !== "toolResult" || message.isError || !QUESTION_TOOL_NAMES.includes(message.toolName)) return "";
	const d = (message.details ?? {}) as Record<string, unknown>;
	return [d.text, d.other, d.thinking ?? d.note, d.readingThinking].filter((v): v is string => typeof v === "string" && v.trim() !== "").join("\n");
}

/** A message he authored: typed, a check's answer, a thinking submission. */
function learnerAuthored(message: LhMessage): boolean {
	if (message.role === "user") return true;
	if (message.role === "custom") return message.customType === "practice-thinking";
	return message.role === "toolResult" && !message.isError && QUESTION_TOOL_NAMES.includes(message.toolName);
}

/** The newest cleanly posed check or problem call before index `before`. */
function lastPosedBefore(messages: readonly LhMessage[], before: number, names: readonly string[]): string | null {
	const clean = new Set(messages.flatMap((m) => (m.role === "toolResult" && !m.isError ? [m.toolCallId] : [])));
	for (let i = before - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (let b = m.content.length - 1; b >= 0; b--) {
			const block = m.content[b]!;
			if (block.type === "toolCall" && names.includes(block.name) && clean.has(block.id)) return block.id;
		}
	}
	return null;
}

/** The question a cited message is evidence about (Default 54): a check's
 *  answer → that check; a problem's result, thinking submissions and
 *  conclusion → that problem; a typed message → the newest check or problem
 *  posed before it, else itself (Default 55). null = not his work. */
export function questionKeyOf(messages: readonly LhMessage[], ref: string): string | null {
	const index = messages.findIndex((m) => m.id === ref);
	if (index < 0) return null;
	const m = messages[index]!;
	if (m.role === "user") return lastPosedBefore(messages, index, [...QUESTION_TOOL_NAMES, PRACTICE_PROBLEM_TOOL]) ?? m.id;
	if (m.role === "custom") {
		const problem = (m.details as { problemCallId?: unknown } | null)?.problemCallId;
		return m.customType === "practice-thinking" && typeof problem === "string" ? problem : null;
	}
	if (m.role !== "toolResult" || m.isError) return null;
	if (QUESTION_TOOL_NAMES.includes(m.toolName) || m.toolName === PRACTICE_PROBLEM_TOOL) return m.toolCallId;
	if (m.toolName === PRACTICE_CONCLUDE_TOOL) {
		const call = messages.findIndex((x) => x.role === "assistant" && x.content.some((b) => b.type === "toolCall" && b.id === m.toolCallId));
		return lastPosedBefore(messages, call < 0 ? index : call, [PRACTICE_PROBLEM_TOOL]);
	}
	return null;
}

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Default 37: a problem unless the quote has at least 20 characters and
 *  occurs in his own text of the message (case and whitespace ignored). */
export function quoteProblem(quote: string | undefined, message: LhMessage): string | null {
	const q = squash(quote ?? "");
	if (!q) return `a sighting of a flawed model needs a quote: his own words from message ${message.id}, verbatim.`;
	if (q.length < FLAWED_MIN_QUOTE_CHARS) return `the quote must be at least ${FLAWED_MIN_QUOTE_CHARS} characters of his own words (message ${message.id}).`;
	if (!squash(learnerTextOf(message)).includes(q)) return `the quote does not appear in his text of message ${message.id}. Quote his own words exactly, or drop this sighting.`;
	return null;
}

// ─── when the curator runs (Default 27) ─────────────────────────────────────

/** A milestone after the cursor: a concluded probe, a concluded (not
 *  dismissed) problem, or 5 answered teaching checks. */
export function curationDue(messages: readonly LhMessage[], cursor: string | undefined): boolean {
	const start = cursor === undefined ? 0 : messages.findIndex((m) => m.id === cursor) + 1;
	const probeDone = probeDoneResultIds(messages);
	const args = new Map<string, unknown>();
	for (const m of messages) if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") args.set(b.id, b.arguments);
	let checks = 0;
	for (const m of messages.slice(start)) {
		if (m.role !== "toolResult" || m.isError) continue;
		if (probeDone.has(m.id)) return true;
		if (m.toolName === PRACTICE_CONCLUDE_TOOL && (args.get(m.toolCallId) as { outcome?: unknown } | undefined)?.outcome !== "dismissed") return true;
		if ((m.toolName === "quiz" || m.toolName === "explain") && (m.details as { dismissed?: unknown } | null)?.dismissed !== true) {
			if (++checks >= CHECKS_PER_CURATION) return true;
		}
	}
	return false;
}

// ─── the curator's operations (task 13 submit, validated here) ──────────────

export interface CuratorEvidence {
	/** A message id inside the curated span. */
	ref: string;
	note: string;
	/** Required on confirming sightings of a flawed thinking model. */
	quote?: string;
}

export type CuratorOp =
	| { op: "new"; kind: "knowledge" | "thinking" | "mistake"; area: string; newAreaDescription?: string; text: string; flawed?: boolean; evidence: CuratorEvidence[]; graphNodeIds?: string[] }
	| { op: "sighting"; id: string; stance: "confirm" | "contradict"; evidence: CuratorEvidence[] }
	| { op: "revise"; id: string; text: string; evidence: CuratorEvidence[] }
	| { op: "promote"; ids: string[]; text: string; evidence: CuratorEvidence[] };

export interface CuratorSubmit {
	subject: string;
	newSubject?: boolean;
	ops: CuratorOp[];
}

export interface CuratorContext {
	chatId: string;
	/** The whole saved record (question keys look back past the span). */
	messages: readonly LhMessage[];
	/** The message ids the curator was shown. */
	span: ReadonlySet<string>;
	/** The session's subject from the transcript (memory_subject), if any. */
	sessionSubject: string | null;
	at: string;
	/** Present when the graph tools are on: does this proposition id exist? */
	graphHas?: (id: string) => boolean;
}

/** Profile bar (Defaults 31, 41): among confirming curator sightings, two
 *  subjects each meet the bar on their own. */
export function meetsProfileBar(m: Pick<Memory, "kind" | "flawed" | "entries">): boolean {
	return profileBarCounts(m).filter((c) => c.met).length >= 2;
}

function profileBarCounts(m: Pick<Memory, "kind" | "flawed" | "entries">): { subject: string; questions: number; sessions: number; met: boolean }[] {
	const flawed = isFlawed(m);
	const confirms = flawed ? confirmsSinceContradiction(m.entries) : m.entries.filter((e) => e.by === "curator" && e.stance === "confirm");
	const bySubject = new Map<string, MemoryEntry[]>();
	for (const e of confirms) if (e.subject) bySubject.set(e.subject, [...(bySubject.get(e.subject) ?? []), e]);
	return [...bySubject].map(([subject, es]) => {
		const questions = distinct(es.map(questionOf));
		const sessions = distinct(es.map((e) => e.source?.chatId ?? ""));
		return { subject, questions, sessions, met: flawed ? questions >= FLAWED_MIN_QUESTIONS && sessions >= FLAWED_MIN_SESSIONS : questions >= SIGHTINGS_TO_ACTIVATE };
	});
}

/** Default 32: other subjects' loaded mistake patterns and active flawed
 *  thinking models — the only memories of another subject the curator sees. */
export function otherSubjectMistakes(file: MemoryFile, subject: string | null): Memory[] {
	return file.memories.filter((m) => m.subject && m.subject !== subject && ((m.kind === "mistake" && isLoaded(m)) || (isFlawed(m) && memoryStatus(m) === "active")));
}

function statusLabel(m: Memory): string {
	const status = memoryStatus(m);
	if (status !== "unconfirmed") return status;
	const { questions, sessions } = flawedProgress(m);
	return `unconfirmed: ${questions} of ${FLAWED_MIN_QUESTIONS} questions, ${sessions} of ${FLAWED_MIN_SESSIONS} sessions`;
}

/** The curator's view: every memory it may attach to, with ids and status. */
export function curatorMemoryText(file: MemoryFile, subject: string | null, now: Date = new Date()): string {
	const line = (m: Memory) => `- [${m.id}] (${m.kind}; ${statusLabel(m)}${strengthLine(m, now) ? `; ${strengthLine(m, now)}` : ""}) ${memoryText(m)}`;
	const profile = profileMemories(file);
	const parts = [`### Profile (${profile.length} of ${PROFILE_CAP})\n${profile.map(line).join("\n") || "Empty."}`, `### Subjects\n${subjectsOf(file).join(", ") || "None yet."}`];
	if (subject && subjectsOf(file).includes(subject)) {
		const lines = file.memories.filter((m) => m.subject === subject && !m.area).map(line);
		for (const area of areasOf(file, subject)) {
			lines.push(`#### ${area}: ${file.areas[subject]?.[area] ?? ""}`, ...file.memories.filter((m) => m.subject === subject && m.area === area).map(line));
		}
		parts.push(`### ${subject} (every memory, every status)\n${lines.join("\n")}`);
	}
	const others = otherSubjectMistakes(file, subject);
	parts.push(`### Mistake patterns and flawed thinking models under his other subjects\n${others.map((m) => `- [${m.id}] (${m.subject}${m.area ? ` › ${m.area}` : ""}; ${m.kind}${isFlawed(m) ? ", flawed" : ""}; ${statusLabel(m)}) ${memoryText(m)}`).join("\n") || "None."}`);
	return parts.join("\n\n");
}

type OpResult = { file: MemoryFile } | { problems: string[] };

/** Default 60: the subject the curator files under, or the refusal. */
function curatorSubject(file: MemoryFile, submit: CuratorSubmit, sessionSubject: string | null): string | { problem: string } {
	const subjects = subjectsOf(file);
	const named = resolveName(subjects, submit.subject);
	const asNew = submit.subject.trim();
	if (sessionSubject) {
		const bound = resolveName(subjects, sessionSubject);
		if (bound) return named === bound ? bound : { problem: `This session's subject is ${bound}; set subject to "${bound}".` };
		const isSession = asNew.toLowerCase() === sessionSubject.trim().toLowerCase();
		if (subjects.length === 0) return isSession ? sessionSubject.trim() : { problem: `This session's subject is ${sessionSubject}; set subject to "${sessionSubject}".` };
		if (named) return named;
		if (isSession && submit.newSubject) return sessionSubject.trim();
		return {
			problem:
				`This session's subject "${sessionSubject}" holds no memories yet, and other subjects exist: ${subjects.join(", ")}. ` +
				`Set subject to one of them if it is the same subject, or to "${sessionSubject}" with newSubject: true.`,
		};
	}
	if (named) return named;
	if (submit.newSubject && asNew) return asNew;
	return { problem: `No subject named "${asNew}". Existing subjects: ${subjects.join(", ") || "none"}. Reuse one, or set newSubject: true.` };
}

/**
 * Validate and apply the curator's submit (task 13). All or nothing: any
 * problem refuses the whole submit so the curator can fix it and resubmit.
 * Ops apply in order, so a sighting earlier in the submit counts toward a
 * later promotion.
 */
export function applyCuratorOps(file: MemoryFile, submit: CuratorSubmit, ctx: CuratorContext): OpResult {
	if (submit.ops.length === 0) return { file };
	const subject = curatorSubject(file, submit, ctx.sessionSubject);
	if (typeof subject !== "string") return { problems: [subject.problem] };
	const problems: string[] = [];
	let working = file;
	submit.ops.forEach((op, i) => {
		const r = applyOne(working, op, subject, ctx);
		if ("problems" in r) problems.push(...r.problems.map((p) => `ops[${i}] (${op.op}): ${p}`));
		else working = r.file;
	});
	return problems.length > 0 ? { problems } : { file: working };
}

/** One evidence item → one curator entry, or a problem. */
function sightingEntry(ev: CuratorEvidence, target: Pick<Memory, "kind" | "flawed">, stance: MemoryEntry["stance"], subject: string, ctx: CuratorContext, extra: Partial<MemoryEntry> = {}): MemoryEntry | string {
	if (!ctx.span.has(ev.ref)) return `${ev.ref} is not a message id in the part of the session you were shown.`;
	const message = ctx.messages.find((m) => m.id === ev.ref)!;
	const question = questionKeyOf(ctx.messages, ev.ref);
	if (!question) return `${ev.ref} is a tutor message or not his work; cite his answered check, the concluded problem, or his own message.`;
	if (isFlawed(target)) {
		if (!learnerAuthored(message)) return `${ev.ref} is not his own message; evidence about a flawed thinking model must cite a message he wrote.`;
		if (stance === "confirm") {
			const problem = quoteProblem(ev.quote, message);
			if (problem) return problem;
		}
	}
	return {
		at: ctx.at,
		by: "curator",
		source: { chatId: ctx.chatId, ref: ev.ref },
		note: ev.note.trim(),
		stance,
		subject,
		question,
		...(isFlawed(target) && ev.quote ? { quote: ev.quote.trim() } : {}),
		...extra,
	};
}

function entriesFor(evidence: CuratorEvidence[], target: Pick<Memory, "kind" | "flawed">, stance: MemoryEntry["stance"], subject: string, ctx: CuratorContext, first: Partial<MemoryEntry> = {}): MemoryEntry[] | { problems: string[] } {
	if (evidence.length === 0) return { problems: ["every op needs at least one evidence item."] };
	const out: MemoryEntry[] = [];
	const problems: string[] = [];
	evidence.forEach((ev, i) => {
		const entry = sightingEntry(ev, target, stance, subject, ctx, i === 0 ? first : {});
		if (typeof entry === "string") problems.push(entry);
		else out.push(entry);
	});
	return problems.length > 0 ? { problems } : out;
}

/** May the curator attach to this memory from a session in `subject`? */
function curatorMayTouch(file: MemoryFile, m: Memory, subject: string): string | null {
	if (m.kind === "preference") return `${m.id} is a preference; the curator does not write preferences or goals.`;
	if (!m.subject || m.subject === subject) return null;
	return otherSubjectMistakes(file, subject).includes(m) ? null : `${m.id} is filed under ${m.subject} and is not shown to you; write a new memory instead.`;
}

function applyOne(file: MemoryFile, op: CuratorOp, subject: string, ctx: CuratorContext): OpResult {
	const replace = (memory: Memory): OpResult => ({ file: { ...file, memories: file.memories.map((m) => (m.id === memory.id ? memory : m)) } });
	switch (op.op) {
		case "new": {
			if ((op.kind as string) === "preference" || !["knowledge", "thinking", "mistake"].includes(op.kind)) return { problems: ["kind must be knowledge, thinking or mistake; preferences and goals are not yours to write."] };
			if (op.kind === "thinking" && typeof op.flawed !== "boolean") return { problems: ["a thinking memory needs flawed: true (a flawed model) or false (a sound one)."] };
			if (op.kind !== "thinking" && op.flawed !== undefined) return { problems: ["flawed is only for thinking memories."] };
			if (!op.text.trim()) return { problems: ["text must not be empty."] };
			if (op.graphNodeIds?.length) {
				if (op.kind !== "knowledge") return { problems: ["graphNodeIds are only for knowledge memories."] };
				if (!ctx.graphHas) return { problems: ["the graph tools are off; leave graphNodeIds out."] };
				const missing = op.graphNodeIds.filter((id) => !ctx.graphHas!(id));
				if (missing.length > 0) return { problems: [`no proposition has the id ${missing.join(", ")}.`] };
			}
			const place = resolvePlacement(file, { level: "area", subject, newSubject: true, area: op.area, newAreaDescription: op.newAreaDescription });
			if ("problems" in place) return place;
			const target = { kind: op.kind, ...(op.flawed !== undefined ? { flawed: op.flawed } : {}) };
			const entries = entriesFor(op.evidence, target, "confirm", subject, ctx, { text: op.text.trim() });
			if ("problems" in entries) return entries;
			const memory: Memory = { id: newMemoryId(file), ...target, subject, area: place.area!, entries, ...(op.graphNodeIds?.length ? { graphNodeIds: [...new Set(op.graphNodeIds)] } : {}) };
			const areas = place.newArea ? { ...file.areas, [subject]: { ...file.areas[subject], [place.area!]: op.newAreaDescription!.trim() } } : file.areas;
			return { file: { ...file, memories: [...file.memories, memory], areas } };
		}
		case "sighting":
		case "revise": {
			const target = file.memories.find((m) => m.id === op.id);
			if (!target) return { problems: [`no memory has the id ${op.id}.`] };
			const refused = curatorMayTouch(file, target, subject);
			if (refused) return { problems: [refused] };
			if (op.op === "revise" && !op.text.trim()) return { problems: ["text must not be empty."] };
			const entries = entriesFor(op.evidence, target, op.op === "sighting" ? op.stance : "confirm", subject, ctx, op.op === "revise" ? { text: op.text.trim() } : {});
			if ("problems" in entries) return entries;
			return replace({ ...target, entries: [...target.entries, ...entries] });
		}
		case "promote": {
			const ids = [...new Set(op.ids)];
			const named = ids.map((id) => file.memories.find((m) => m.id === id));
			const missing = ids.filter((_, i) => !named[i]);
			if (ids.length === 0 || missing.length > 0) return { problems: [`no memory has the id ${missing.join(", ") || "(none named)"}.`] };
			const memories = named as Memory[];
			const allMistakes = memories.every((m) => m.kind === "mistake");
			const allFlawed = memories.every(isFlawed);
			if (!allMistakes && !allFlawed) return { problems: ["a promotion names only mistake patterns or only flawed thinking models; never mix them."] };
			for (const m of memories) {
				if (!m.subject) return { problems: [`${m.id} is already in the Profile.`] };
				if (m.placedByLearner) return { problems: [`${m.id} was placed by him in Settings; it is never moved or merged.`] };
				const refused = curatorMayTouch(file, m, subject);
				if (refused) return { problems: [refused] };
			}
			if (!op.text.trim()) return { problems: ["text must not be empty."] };
			const others = file.memories.filter((m) => !ids.includes(m.id));
			if (others.filter((m) => !m.subject).length >= PROFILE_CAP) return { problems: [`the Profile is full (${PROFILE_CAP} of ${PROFILE_CAP}); do not promote until it has room.`] };
			const first = memories[0]!;
			const shape = { kind: first.kind, ...(allFlawed ? { flawed: true } : {}) };
			const promotedFrom = { subject: first.subject!, ...(first.area ? { area: first.area, areaDescription: file.areas[first.subject!]?.[first.area] ?? "" } : {}) };
			const added = entriesFor(op.evidence, shape, "confirm", subject, ctx, { text: op.text.trim(), promotedFrom });
			if ("problems" in added) return added;
			// Merged evidence in time order; the promotion's own entry last.
			const merged = memories.flatMap((m) => m.entries).sort((a, b) => a.at.localeCompare(b.at));
			const promoted: Memory = { id: newMemoryId(file), ...shape, entries: [...merged, ...added.slice(1), added[0]!] };
			if (!meetsProfileBar(promoted)) {
				const need = allFlawed ? `${FLAWED_MIN_QUESTIONS} questions over ${FLAWED_MIN_SESSIONS} sessions` : `${SIGHTINGS_TO_ACTIVATE} questions`;
				const counts = profileBarCounts(promoted).map((c) => `${c.subject} has ${c.questions} question${c.questions === 1 ? "" : "s"}${allFlawed ? ` over ${c.sessions} session${c.sessions === 1 ? "" : "s"}` : ""}`);
				return { problems: [`not enough evidence: ${counts.join(", ") || "no subject has sightings"}; each of two subjects needs ${need}.`] };
			}
			if (memoryStatus(promoted) !== "active") return { problems: [`the merged pattern is ${memoryStatus(promoted)}, not active.`] };
			return { file: pruneAreas({ ...file, memories: [...others, promoted] }) };
		}
	}
}

// ─── notices (Default 25) ───────────────────────────────────────────────────

export interface MemoryNotice {
	memoryId: string;
	text: string;
	/** The cited message the notice sits under. */
	ref: string;
}

/** For each loaded memory: the curator entry in this chat that made it
 *  active, revised it while active, or promoted it (the last such one). */
export function memoryNoticesFor(file: MemoryFile, chatId: string): MemoryNotice[] {
	const out: MemoryNotice[] = [];
	for (const m of file.memories) {
		if (!isLoaded(m)) continue;
		let ref: string | undefined;
		let before = false;
		m.entries.forEach((e, i) => {
			const after = isLoaded({ ...m, entries: m.entries.slice(0, i + 1) });
			if (e.by === "curator" && e.source?.chatId === chatId && after && (!before || e.text !== undefined || e.promotedFrom)) ref = e.source.ref;
			before = after;
		});
		if (ref) out.push({ memoryId: m.id, text: memoryText(m), ref });
	}
	return out;
}

// ─── projections for the model ──────────────────────────────────────────────

const loadedIn = (file: MemoryFile, keep: (m: Memory) => boolean) => file.memories.filter((m) => keep(m) && isLoaded(m));

export function profileLines(file: MemoryFile, now?: Date): string {
	return loadedIn(file, (m) => !m.subject).map((m) => memoryLine(m, now)).join("\n");
}

/** Areas of a subject holding at least one loaded memory (Default 61). */
export function visibleAreasOf(file: MemoryFile, subject: string): string[] {
	return areasOf(file, subject).filter((area) => loadedIn(file, (m) => m.subject === subject && m.area === area).length > 0);
}

/** Subject-level memories, then the area names with their descriptions. */
export function subjectIndex(file: MemoryFile, subject: string, now?: Date): string {
	const lines = loadedIn(file, (m) => m.subject === subject && !m.area).map((m) => memoryLine(m, now));
	const areas = visibleAreasOf(file, subject);
	if (areas.length > 0) {
		lines.push("Areas (open with memory_read):");
		for (const area of areas) lines.push(`- ${area}: ${file.areas[subject]?.[area] ?? ""}`);
	}
	if (lines.length > 0) return lines.join("\n");
	return subjectsOf(file).includes(subject) ? "No memories to show yet." : "New subject, no memories yet.";
}

export function areaContents(file: MemoryFile, subject: string, area: string, now?: Date): string {
	return loadedIn(file, (m) => m.subject === subject && m.area === area).map((m) => memoryLine(m, now)).join("\n");
}

export type MemoryAgentKind = "prober" | "teacher" | "practice";

/** The fixed doctrine (Default 19): travels with the memory block only. */
function memoryDoctrine(kind: MemoryAgentKind): string {
	const ask = kind === "practice" ? "ask him in one plain sentence" : "ask him with `ask_user_question`";
	return `## Memory

You keep a memory of this learner across sessions. What appears below was saved in earlier sessions. Use it without comment: never say that you remember something, and never mention this section.

**Where things are.** The Profile below is always loaded. Everything else is filed under a subject, then an area. As soon as the first messages make this session's subject clear, call \`memory_subject\` with it, reusing a name from the subject list when it is the same subject. If you cannot tell the subject after a few messages, ${ask}. Once the subject is set you see its areas with one-line descriptions; open an area with \`memory_read\` when its description is relevant to what you are about to do.

**What to save.** Call \`remember\` when he states a preference about how he wants to be taught or practised, or a goal, and whenever he asks you to remember something, whatever it is. Save what he said, not what you infer: one specific sentence that will still be true after today. Do not save what he got right or wrong or how you think he reasons; that is recorded after the session.

**Where to save.** File each memory at the narrowest level where it is true: an area if it only holds there, the subject if it holds across the subject, the Profile only if it holds for everything he studies.

**No duplicates.** If a memory already says it, do not save it again. If he changes or corrects one, save with \`replaces\` set to that memory's id.`;
}

/** Phase 2 role paragraphs (approved wording), one per agent kind. */
const ROLE_PARAGRAPHS: Record<MemoryAgentKind, string> = {
	prober:
		"**Prober.** Knowledge memories for this subject are an earlier measurement of his edge. For each strand that has one, ask one question placed at the remembered edge. If the answer matches, the strand is bracketed; move on. If it does not, the memory is out of date: probe that strand as usual. Treat a memory marked old as a hint for where to open, not as a bracket. A thinking model marked flawed is a hypothesis: ask one question where the sound model and the flawed one give different answers, and record what his thinking shows.",
	teacher:
		"**Teacher.** Plan and present with his preferences and thinking-model memories in mind. Build from the models marked sound. A model marked flawed is a hypothesis recorded from earlier sessions, not a fact about him today: never tell him he thinks that way. Put a check where the sound model and the flawed one give different answers, read his thinking, and repair it only if he shows it again. Where a mistake pattern touches a step, put the check exactly there.",
	practice:
		"**Practice.** Choose problems that exercise his recorded mistake patterns for this area, without saying that is why. When he repeats one, name the pattern in your verdict. Treat a thinking model marked flawed as something to test, not to announce: choose a problem where it gives the wrong result, and name it only when his thinking trace shows it again.",
};

/** The full text appended to the system prompt when memory is on. */
export function memoryPromptBlock(file: MemoryFile, subject: string | null, kind: MemoryAgentKind, now: Date = new Date()): string {
	const profile = profileMemories(file);
	const subjects = subjectsOf(file);
	const shown = profileLines(file, now);
	const parts = [
		memoryDoctrine(kind),
		ROLE_PARAGRAPHS[kind],
		`### Profile (${profile.length} of ${PROFILE_CAP})${shown ? `\n${shown}` : ""}`,
		`### Subjects\n${subjects.length > 0 ? subjects.join(", ") : "None yet."}`,
		subject
			? `### This session's subject: ${subject}\n${subjectIndex(file, subject, now)}`
			: "### This session's subject: not set. Call memory_subject once it is clear.",
	];
	// Default 59: the prober sees every loaded knowledge memory of the subject.
	if (kind === "prober" && subject) {
		const knowledge = loadedIn(file, (m) => m.subject === subject && m.kind === "knowledge" && !!m.area);
		if (knowledge.length > 0) parts.push(`### Knowledge memories for ${subject}\n${knowledge.map((m) => `${memoryLine(m, now)} [${m.area}]`).join("\n")}`);
	}
	return parts.join("\n\n");
}

// ─── the Settings view ──────────────────────────────────────────────────────

/** Resolve one entry's source; called with the entry's source (never absent). */
export type EvidenceResolver = (source: { chatId: string; ref: string }) => Exclude<MemoryEvidenceWhere, "settings">;

function memoryRow(m: Memory, resolve: EvidenceResolver, propositionName?: (id: string) => string | undefined): MemoryRow {
	const status = memoryStatus(m);
	const propositions = (m.graphNodeIds ?? []).flatMap((id) => {
		const name = propositionName?.(id);
		return name ? [{ id, name }] : [];
	});
	return {
		id: m.id,
		kind: m.kind,
		text: memoryText(m),
		at: m.entries.at(-1)!.at,
		status,
		...(status === "unconfirmed" ? { progress: flawedProgress(m) } : {}),
		...(m.kind === "thinking" && m.flawed !== undefined ? { flawed: m.flawed } : {}),
		...(m.placedByLearner ? { placedByLearner: true } : {}),
		...(propositions.length > 0 ? { propositions } : {}),
		evidence: m.entries.map((e) => ({
			at: e.at,
			by: e.by,
			note: e.note,
			where: e.source ? resolve(e.source) : "settings",
			stance: e.stance,
			...(e.subject ? { subject: e.subject } : {}),
			...(e.quote ? { quote: e.quote } : {}),
			...(e.promotedFrom ? { promotedFrom: e.promotedFrom } : {}),
		})),
	};
}

export function memoryView(file: MemoryFile, enabled: boolean, resolve: EvidenceResolver, propositionName?: (id: string) => string | undefined): MemoryView {
	const row = (m: Memory) => memoryRow(m, resolve, propositionName);
	return {
		enabled,
		profileCap: PROFILE_CAP,
		profile: profileMemories(file).map(row),
		subjects: subjectsOf(file).map((name) => ({
			name,
			memories: file.memories.filter((m) => m.subject === name && !m.area).map(row),
			areas: areasOf(file, name).map((area) => ({
				name: area,
				description: file.areas[name]?.[area] ?? "",
				memories: file.memories.filter((m) => m.subject === name && m.area === area).map(row),
			})),
		})),
	};
}
