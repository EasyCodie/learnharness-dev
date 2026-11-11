/**
 * Learner memory service (plan: docs/superpowers/plans/2026-11-10-learner-memory.md):
 * the per-turn wiring for the agents, the reconcile step for Undo and
 * failed settles, and the Settings → Memory operations behind /api/memory.
 * Every write emits "memory-changed".
 */

import { emit } from "../core/events.ts";
import {
	MEMORY_KINDS,
	MemoryUnavailableError,
	PROFILE_CAP,
	applyRemember,
	memoryNoticesFor,
	memoryPromptBlock,
	memoryView,
	profileMemories,
	pruneAreas,
	reconcileWithChat,
	resolveName,
	resolvePlacement,
	sessionSubject,
	subjectsOf,
	areasOf,
	type MemoryAgentKind,
	type RememberInput,
} from "../core/memory.ts";
import type { MemoryFile, MemoryKind, MemoryLevel, MemoryNoticeView, MemoryView } from "../core/contracts/memory.ts";
import type { LhMessage } from "../core/native-messages.ts";
import type { MemoryToolContext } from "../agent/tools/memory.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { getGraph } from "../core/graph.ts";

const changed = () => emit("memory-changed", {});

/** The prompt block and tool context for one turn, or null when memory is
 *  off or memory.json cannot be read (the agent is built without memory). */
export function memoryForTurn(
	enabled: boolean,
	chatId: string,
	messages: readonly LhMessage[],
	kind: MemoryAgentKind,
): { block: string; tools: MemoryToolContext } | null {
	if (!enabled) return null;
	let block: string;
	try {
		// Inside the try: a parseable but malformed file skips memory too.
		block = memoryPromptBlock(stores.memoryStore.read(), sessionSubject(messages), kind);
	} catch (error) {
		console.warn(`[memory] unavailable for this turn: ${(error as Error).message}`);
		return null;
	}
	return { block, tools: { chatId, chatStore: stores.chatStore, memoryStore: stores.memoryStore, onChange: changed } };
}

/** Drop this chat's memory entries that cite calls not in `messages`
 *  (default: the saved record). Returns how many memories were deleted.
 *  Throws MemoryUnavailableError when the file cannot be read. */
export function reconcileMemoryWithChat(chatId: string, messages?: readonly LhMessage[]): number {
	const kept = messages ?? stores.chatStore.getChat(chatId)?.messages;
	// No record (unknown or unreadable chat): never read as "every call is gone".
	if (!kept) return 0;
	const result = reconcileWithChat(stores.memoryStore.read(), chatId, kept);
	if (!result.changed) return 0;
	stores.memoryStore.write(result.file);
	changed();
	return result.removed;
}

/** The settle-time reconcile: never throws (an unreadable file is skipped;
 *  a later settle cleans up once it is repaired). */
export function reconcileMemoryAtSettle(chatId: string): void {
	try {
		reconcileMemoryWithChat(chatId);
	} catch (error) {
		console.warn(`[memory] reconcile skipped for ${chatId}: ${(error as Error).message}`);
	}
}

// ─── Settings → Memory ───────────────────────────────────────────────────────

export type MemoryOutcome<T = unknown> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 503; error: string };

function withFile<T>(run: (file: MemoryFile) => MemoryOutcome<T> & { file?: MemoryFile }): MemoryOutcome<T> {
	let file: MemoryFile;
	try {
		file = stores.memoryStore.read();
	} catch (error) {
		if (error instanceof MemoryUnavailableError) return { ok: false, status: 503, error: error.message };
		throw error;
	}
	const outcome = run(file);
	if (outcome.ok && outcome.file) {
		stores.memoryStore.write(outcome.file);
		changed();
	}
	return outcome.ok ? { ok: true, value: outcome.value } : outcome;
}

/** GET /api/memory: the tree, each evidence line resolved to its session. */
export function readMemoryView(): MemoryView {
	const enabled = effectiveSettings().memory.enabled;
	let file: MemoryFile;
	try {
		file = stores.memoryStore.read();
	} catch (error) {
		return { enabled, error: (error as Error).message, profileCap: PROFILE_CAP, profile: [], subjects: [] };
	}
	const chats = new Map<string, ReturnType<typeof stores.chatStore.getChat>>();
	// Knowledge links (task 15): ids no longer in the graph are hidden.
	let names: Map<string, string> | undefined;
	const propositionName = (id: string) => {
		if (!names) {
			try {
				names = new Map(getGraph(stores.graphStore).nodes.map((n) => [n.id, n.name]));
			} catch {
				names = new Map();
			}
		}
		return names.get(id);
	};
	return memoryView(
		file,
		enabled,
		({ chatId, ref }) => {
			if (!chats.has(chatId)) chats.set(chatId, stores.chatStore.getChat(chatId));
			const chat = chats.get(chatId);
			if (!chat) return "deleted";
			return { chatId, chatTitle: chat.title, anchor: anchorFor(chat.messages, ref) };
		},
		propositionName,
	);
}

/** The DOM anchor (message-<anchor>) for a cited ref: a remember call's id
 *  (RememberCard), a cited answer or conclusion's call id (its card), or a
 *  typed message or thinking submission's own id. null = open the chat. */
function anchorFor(messages: readonly LhMessage[], ref: string): string | null {
	for (const m of messages) {
		if (m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === ref)) return ref;
		if (m.id !== ref) continue;
		if (m.role === "toolResult") return m.toolCallId;
		return m.role === "user" || m.role === "custom" ? m.id : null;
	}
	return null;
}

/** GET /api/memory/notices: the curator's "remembered: …" lines for one
 *  chat (Default 25), each anchored like evidence links. Shown whether or not
 *  memory is on, like the in-chat "remembered" lines; empty when unreadable. */
export function readMemoryNotices(chatId: string): MemoryNoticeView[] {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return [];
	let file: MemoryFile;
	try {
		file = stores.memoryStore.read();
	} catch {
		return [];
	}
	return memoryNoticesFor(file, chatId).flatMap((n) => {
		const anchor = anchorFor(chat.messages, n.ref);
		return anchor ? [{ memoryId: n.memoryId, text: n.text, anchor }] : [];
	});
}

const isKind = (v: unknown): v is MemoryKind => typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v);
const isLevel = (v: unknown): v is MemoryLevel => v === "profile" || v === "subject" || v === "area";
const optString = (v: unknown) => (v === undefined || typeof v === "string");

interface PlacementBody {
	level: MemoryLevel;
	subject?: string;
	newSubject?: boolean;
	area?: string;
	newAreaDescription?: string;
}

function parsePlacement(raw: Record<string, unknown>): PlacementBody | string {
	if (!isLevel(raw.level)) return "level must be profile, subject or area";
	if (!optString(raw.subject) || !optString(raw.area) || !optString(raw.newAreaDescription)) return "subject, area and newAreaDescription must be strings";
	if (raw.newSubject !== undefined && typeof raw.newSubject !== "boolean") return "newSubject must be a boolean";
	return raw as unknown as PlacementBody;
}

const asObject = (body: unknown): Record<string, unknown> | null =>
	body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

/** A sound/flawed mark from Settings: thinking memories only (Default 35). */
function parseMark(flawed: unknown, kind: unknown): boolean | undefined | string {
	if (flawed === undefined) return undefined;
	if (typeof flawed !== "boolean") return "flawed must be a boolean";
	return kind === "thinking" ? flawed : "flawed is only for thinking memories";
}

/** POST /api/memory: Ivan adds a memory by hand (Default 16). */
export function addMemory(body: unknown): MemoryOutcome<{ id: string }> {
	const raw = asObject(body);
	if (!raw) return { ok: false, status: 400, error: "Invalid JSON body" };
	if (!isKind(raw.kind)) return { ok: false, status: 400, error: `kind must be one of ${MEMORY_KINDS.join(", ")}` };
	if (typeof raw.text !== "string") return { ok: false, status: 400, error: "text must be a string" };
	const placement = parsePlacement(raw);
	if (typeof placement === "string") return { ok: false, status: 400, error: placement };
	const mark = parseMark(raw.flawed, raw.kind);
	if (typeof mark === "string") return { ok: false, status: 400, error: mark };
	return withFile((file) => {
		const input: RememberInput = { ...placement, kind: raw.kind as MemoryKind, text: raw.text as string, confirmNew: true, note: "Added by you in Settings" };
		const result = applyRemember(file, input, { at: new Date().toISOString(), by: "learner" });
		if ("problems" in result) return { ok: false, status: 400, error: result.problems.join("\n") };
		const memories = mark === undefined ? result.file.memories : result.file.memories.map((m) => (m.id === result.memory.id ? { ...m, flawed: mark } : m));
		return { ok: true, value: { id: result.memory.id }, file: { ...result.file, memories } };
	});
}

/** PUT /api/memory/[id]: edit text, change kind, and/or move. */
export function editMemory(id: string, body: unknown): MemoryOutcome<{ id: string }> {
	const raw = asObject(body);
	if (!raw) return { ok: false, status: 400, error: "Invalid JSON body" };
	if (raw.text !== undefined && (typeof raw.text !== "string" || !raw.text.trim())) return { ok: false, status: 400, error: "text must be a non-empty string" };
	if (raw.kind !== undefined && !isKind(raw.kind)) return { ok: false, status: 400, error: `kind must be one of ${MEMORY_KINDS.join(", ")}` };
	const moveRaw = raw.move === undefined ? null : asObject(raw.move);
	if (raw.move !== undefined && !moveRaw) return { ok: false, status: 400, error: "move must be an object" };
	const move = moveRaw ? parsePlacement(moveRaw) : null;
	if (typeof move === "string") return { ok: false, status: 400, error: move };
	return withFile((file) => {
		const index = file.memories.findIndex((m) => m.id === id);
		if (index < 0) return { ok: false, status: 404, error: "No such memory" };
		let memory = { ...file.memories[index]! };
		let areas = file.areas;
		if (typeof raw.text === "string") {
			memory.entries = [...memory.entries, { at: new Date().toISOString(), by: "learner", note: "Edited by you in Settings", stance: "confirm", text: raw.text.trim() }];
		}
		if (isKind(raw.kind)) memory.kind = raw.kind;
		if (memory.kind !== "thinking") {
			delete memory.flawed;
			delete memory.markedByLearner;
		}
		// Ivan setting the mark is his statement (Default 56).
		const mark = parseMark(raw.flawed, memory.kind);
		if (typeof mark === "string") return { ok: false, status: 400, error: mark };
		if (mark !== undefined) memory = { ...memory, flawed: mark, markedByLearner: true };
		if (move) {
			const others = { ...file, memories: file.memories.filter((m) => m.id !== id) };
			const place = resolvePlacement(file, move);
			if ("problems" in place) return { ok: false, status: 400, error: place.problems.join("\n") };
			if (move.level === "profile" && memory.subject && profileMemories(others).length >= PROFILE_CAP) {
				return { ok: false, status: 400, error: `The Profile is full (${PROFILE_CAP} of ${PROFILE_CAP}).` };
			}
			const { subject: _s, area: _a, ...rest } = memory;
			memory = { ...rest, ...(place.subject ? { subject: place.subject } : {}), ...(place.area ? { area: place.area } : {}), placedByLearner: true };
			if (place.newArea) areas = { ...areas, [place.subject!]: { ...areas[place.subject!], [place.area!]: move.newAreaDescription!.trim() } };
		}
		const memories = file.memories.map((m, i) => (i === index ? memory : m));
		return { ok: true, value: { id }, file: pruneAreas({ ...file, memories, areas }) };
	});
}

/** DELETE /api/memory/[id]. */
export function deleteMemory(id: string): MemoryOutcome<{ id: string }> {
	return withFile((file) => {
		if (!file.memories.some((m) => m.id === id)) return { ok: false, status: 404, error: "No such memory" };
		return { ok: true, value: { id }, file: pruneAreas({ ...file, memories: file.memories.filter((m) => m.id !== id) }) };
	});
}

/** PUT /api/memory/areas: rename a subject (no area) or an area, or edit an
 *  area's description. A rename onto an existing name is refused. */
export function editAreas(body: unknown): MemoryOutcome<null> {
	const raw = asObject(body);
	if (!raw || typeof raw.subject !== "string") return { ok: false, status: 400, error: "subject is required" };
	if (!optString(raw.area) || !optString(raw.newName) || !optString(raw.description)) return { ok: false, status: 400, error: "area, newName and description must be strings" };
	const newName = (raw.newName as string | undefined)?.trim();
	const description = (raw.description as string | undefined)?.trim();
	if (raw.newName !== undefined && !newName) return { ok: false, status: 400, error: "newName must not be empty" };
	if (newName === undefined && description === undefined) return { ok: false, status: 400, error: "give newName or description" };
	if (raw.area === undefined && description !== undefined) return { ok: false, status: 400, error: "description belongs to an area" };
	return withFile((file) => {
		const subject = resolveName(subjectsOf(file), raw.subject as string);
		if (!subject) return { ok: false, status: 404, error: "No such subject" };
		if (raw.area === undefined) {
			const clash = resolveName(subjectsOf(file).filter((s) => s !== subject), newName!);
			if (clash) return { ok: false, status: 400, error: `A subject named "${clash}" already exists` };
			// Every sighting's subject and promotion origin too, so a renamed
			// subject never counts as two toward the Profile bar.
			const memories = file.memories.map((m) => ({
				...m,
				...(m.subject === subject ? { subject: newName! } : {}),
				entries: m.entries.map((e) => ({
					...e,
					...(e.subject === subject ? { subject: newName! } : {}),
					...(e.promotedFrom?.subject === subject ? { promotedFrom: { ...e.promotedFrom, subject: newName! } } : {}),
				})),
			}));
			const { [subject]: moved, ...areas } = file.areas;
			return { ok: true, value: null, file: { ...file, memories, areas: moved ? { ...areas, [newName!]: moved } : areas } };
		}
		const area = resolveName(areasOf(file, subject), raw.area as string);
		if (!area) return { ok: false, status: 404, error: "No such area" };
		let name = area;
		let memories = file.memories;
		if (newName !== undefined) {
			const clash = resolveName(areasOf(file, subject).filter((a) => a !== area), newName);
			if (clash) return { ok: false, status: 400, error: `An area named "${clash}" already exists under ${subject}` };
			name = newName;
			memories = memories.map((m) => ({
				...m,
				...(m.subject === subject && m.area === area ? { area: name } : {}),
				entries: m.entries.map((e) => (e.promotedFrom?.subject === subject && e.promotedFrom.area === area ? { ...e, promotedFrom: { ...e.promotedFrom, area: name } } : e)),
			}));
		}
		const { [area]: oldDescription, ...rest } = file.areas[subject] ?? {};
		const areas = { ...file.areas, [subject]: { ...rest, [name]: description ?? oldDescription ?? "" } };
		return { ok: true, value: null, file: { ...file, memories, areas } };
	});
}

