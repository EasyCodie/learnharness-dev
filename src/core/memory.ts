/**
 * Learner memory rules (plan: docs/superpowers/plans/2026-11-10-learner-memory.md).
 * Pure: no IO. The store adapter reads/writes the file; the tools, the
 * Settings service and Undo call these.
 */

import type { LhMessage } from "./native-messages.ts";
import type { Memory, MemoryEntry, MemoryEvidenceWhere, MemoryFile, MemoryKind, MemoryLevel, MemoryRow, MemoryView } from "./contracts/memory.ts";

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

/** Phase 1: every memory is active (only Ivan's statements and requests are saved). */
export function memoryStatus(_m: Memory): "active" {
	return "active";
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

export function memoryLine(m: Memory): string {
	return `- [${m.id}] (${m.kind}) ${memoryText(m)}`;
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
			return {
				problems: [
					`The Profile is full (${PROFILE_CAP} of ${PROFILE_CAP}). Replace one of these with replaces, or file the memory under a subject:\n${profile.map(memoryLine).join("\n")}`,
				],
			};
		}
	}

	if (input.level === "area" && !newArea && !input.confirmNew) {
		const same = file.memories.filter((m) => m.subject === subject && m.area === area && m.kind === input.kind);
		if (same.length > 0) {
			return {
				problems: [
					`The area "${area}" already holds these ${input.kind} memories. If one already says this, do not save it again; if he changed one, save with replaces set to its id; if this is new, call again with confirmNew: true.\n${same.map(memoryLine).join("\n")}`,
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

/**
 * Drop this chat's entries whose source is no longer in its transcript
 * (Undo, a failed settle). A memory left without wording is deleted and
 * emptied areas are pruned. Entries without a source, or from other chats,
 * are never touched.
 */
export function reconcileWithChat(file: MemoryFile, chatId: string, messages: readonly LhMessage[]): { file: MemoryFile; removed: number; changed: boolean } {
	const refs = transcriptRefs(messages);
	let removed = 0;
	let changed = false;
	const memories: Memory[] = [];
	for (const m of file.memories) {
		const entries = m.entries.filter((e) => e.source?.chatId !== chatId || refs.has(e.source.ref));
		if (entries.length === m.entries.length) {
			memories.push(m);
			continue;
		}
		changed = true;
		if (entries.some((e) => e.text !== undefined)) memories.push({ ...m, entries });
		else removed++;
	}
	return changed ? { file: pruneAreas({ ...file, memories }), removed, changed } : { file, removed, changed };
}

// ─── projections for the model ──────────────────────────────────────────────

export function profileLines(file: MemoryFile): string {
	return profileMemories(file).map(memoryLine).join("\n");
}

/** Subject-level memories, then the area names with their descriptions. */
export function subjectIndex(file: MemoryFile, subject: string): string {
	const lines = file.memories.filter((m) => m.subject === subject && !m.area).map(memoryLine);
	const areas = areasOf(file, subject);
	if (areas.length > 0) {
		lines.push("Areas (open with memory_read):");
		for (const area of areas) lines.push(`- ${area}: ${file.areas[subject]?.[area] ?? ""}`);
	}
	return lines.length > 0 ? lines.join("\n") : "New subject, no memories yet.";
}

export function areaContents(file: MemoryFile, subject: string, area: string): string {
	return file.memories.filter((m) => m.subject === subject && m.area === area).map(memoryLine).join("\n");
}

export type MemoryAgentKind = "prober" | "teacher" | "practice";

/** The fixed doctrine (Default 19): travels with the memory block only. */
function memoryDoctrine(kind: MemoryAgentKind): string {
	const ask = kind === "practice" ? "ask him in one plain sentence" : "ask him with `ask_user_question`";
	return `## Memory

You keep a memory of this learner across sessions. What appears below was saved in earlier sessions. Use it without comment: never say that you remember something, and never mention this section.

**Where things are.** The Profile below is always loaded. Everything else is filed under a subject, then an area. As soon as the first messages make this session's subject clear, call \`memory_subject\` with it, reusing a name from the subject list when it is the same subject. If you cannot tell the subject after a few messages, ${ask}. Once the subject is set you see its areas with one-line descriptions; open an area with \`memory_read\` when its description is relevant to what you are about to do.

**What to save.** Call \`remember\` when he states a preference about how he wants to be taught or practised, or a goal, and whenever he asks you to remember something, whatever it is. Save what he said, not what you infer: one specific sentence that will still be true after today. Do not save what he got right or wrong or how you think he reasons.

**Where to save.** File each memory at the narrowest level where it is true: an area if it only holds there, the subject if it holds across the subject, the Profile only if it holds for everything he studies.

**No duplicates.** If a memory already says it, do not save it again. If he changes or corrects one, save with \`replaces\` set to that memory's id.`;
}

/** The full text appended to the system prompt when memory is on. */
export function memoryPromptBlock(file: MemoryFile, subject: string | null, kind: MemoryAgentKind): string {
	const profile = profileMemories(file);
	const subjects = subjectsOf(file);
	const parts = [
		memoryDoctrine(kind),
		`### Profile (${profile.length} of ${PROFILE_CAP})${profile.length > 0 ? `\n${profileLines(file)}` : ""}`,
		`### Subjects\n${subjects.length > 0 ? subjects.join(", ") : "None yet."}`,
		subject
			? `### This session's subject: ${subject}\n${subjectIndex(file, subject)}`
			: "### This session's subject: not set. Call memory_subject once it is clear.",
	];
	return parts.join("\n\n");
}

// ─── the Settings view ──────────────────────────────────────────────────────

/** Resolve one entry's source; called with the entry's source (never absent). */
export type EvidenceResolver = (source: { chatId: string; ref: string }) => Exclude<MemoryEvidenceWhere, "settings">;

function memoryRow(m: Memory, resolve: EvidenceResolver): MemoryRow {
	return {
		id: m.id,
		kind: m.kind,
		text: memoryText(m),
		at: m.entries.at(-1)!.at,
		...(m.placedByLearner ? { placedByLearner: true } : {}),
		evidence: m.entries.map((e) => ({ at: e.at, by: e.by, note: e.note, where: e.source ? resolve(e.source) : "settings" })),
	};
}

export function memoryView(file: MemoryFile, enabled: boolean, resolve: EvidenceResolver): MemoryView {
	return {
		enabled,
		profileCap: PROFILE_CAP,
		profile: profileMemories(file).map((m) => memoryRow(m, resolve)),
		subjects: subjectsOf(file).map((name) => ({
			name,
			memories: file.memories.filter((m) => m.subject === name && !m.area).map((m) => memoryRow(m, resolve)),
			areas: areasOf(file, name).map((area) => ({
				name: area,
				description: file.areas[name]?.[area] ?? "",
				memories: file.memories.filter((m) => m.subject === name && m.area === area).map((m) => memoryRow(m, resolve)),
			})),
		})),
	};
}
