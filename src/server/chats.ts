import { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
import { isJobLive } from "../agent/subagents/aborts.ts";
import { coverageOf, coverageSlots } from "../core/coverage.ts";
import { deleteChatTraces, deleteMessageTraces, type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { undoableTail } from "../core/prompt-undo.ts";
import { emit } from "../core/events.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { clearTurnFailure } from "./turn-runs.ts";
import { discardChatDeliveries } from "./jobs.ts";
import { reconcileMemoryWithChat } from "./memory.ts";
import { MemoryUnavailableError } from "../core/memory.ts";
import { sideChats } from "./side-chat.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 *
 * deleteChatSession (wave 6, session deletion — the FIRST destructive
 * operation on the graph ledgers) is the one real orchestration here:
 * gates → extraction wind-down → one synchronous deletion block. See
 * core/graph-deletion.ts for the ledger semantics and the atomicity
 * argument.
 */

export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };
export type { ChatDeleteMode, ChatDeletionStats } from "../core/graph-deletion.ts";

/** How long the wind-down wait may take before the caller gets a retryable
 *  503 (an aborted extraction ends at its next model-call boundary —
 *  provider cancellation is normally sub-second, but a wedged provider
 *  must never wedge deletion). */
const WIND_DOWN_TIMEOUT_MS = 10_000;
const WIND_DOWN_POLL_MS = 50;

/** What deleteChatSession did — the route maps it straight to HTTP. */
export type ChatDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "jobs_running"; error: string; jobIds: string[] }
	| { ok: false; status: 503; code: "extraction_winding_down"; error: string }
	| {
			ok: true;
			mode: ChatDeleteMode;
			stats: ChatDeletionStats;
			jobsRemoved: number;
			graphRevision: number;
	  };

/**
 * Delete a session (owner rulings 2026-09-22/23): gates first, then the
 * purge. The owner-locked choreography:
 *
 *   1. GATES — a turn in flight or a running background job refuses with
 *      409 (they write the chat record and steer into it; deleting
 *      mid-flight would corrupt the write-ahead flow). The UI retries once
 *      work drains.
 *   2. EXTRACTION WIND-DOWN — the chat's own pipeline run is TRUE-
 *      CANCELLED (abortExtraction: spend stops, nothing merges), then
 *      awaited off the registry. A timeout is a retryable 503, never a
 *      forced race.
 *   3. THE SYNC BLOCK — everything below runs without a single await:
 *      no extraction append can interleave (the event loop never yields
 *      mid-block), so the read-filter-write of the ledger rewrites is
 *      atomic against the pipeline. Ledgers first, jobs next, the chat
 *      record LAST (a crash mid-block leaves a deletable chat with a
 *      purged graph — re-running DELETE fixes it — never a deleted chat
 *      with live traces). The pipeline's per-batch liveness guard
 *      (extraction.ts) closes the last window: a run that slipped past
 *      the wind-down finds the chat gone at its merge and aborts with
 *      nothing merged.
 */
export function runningWorkBlocker(chatId: string): Extract<ChatDeleteOutcome, { status: 409 }> | null {
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
			jobIds: [],
		};
	}
	// Legacy records kept completed workers running until delivery. A saved
	// result without a live loop is pending session data, not computing work;
	// deletion must not depend on a prior recovery poll to recognize it.
	const runningJobs = stores.jobStore.listJobs(chatId).filter((job) =>
		job.status === "running" && (!job.result || isJobLive(job.id)));
	if (runningJobs.length > 0) {
		return {
			ok: false,
			status: 409,
			code: "jobs_running",
			error: "Background jobs are still running in this session — try again when they finish",
			jobIds: runningJobs.map((job) => job.id),
		};
	}
	return null;
}

export async function deleteChatSession(chatId: string, mode: ChatDeleteMode): Promise<ChatDeleteOutcome> {
	if (!stores.chatStore.getChat(chatId)) {
		return { ok: false, status: 404, code: "not_found", error: "No such session" };
	}
	const blocker = runningWorkBlocker(chatId);
	if (blocker) return blocker;
	const windDown = await windDownExtraction(chatId);
	if (windDown) return windDown;

	// A result wake or a worker may have started during extraction wind-down.
	// Recheck immediately before the synchronous purge, with no await gap.
	const lateBlocker = runningWorkBlocker(chatId);
	if (lateBlocker) return lateBlocker;

	return finishChatDeletion(chatId, mode);
}

/** True-cancel the chat's extraction run (spend stops, nothing merges) and
 * wait for it to leave the registry; a wedged run is a retryable 503. */
async function windDownExtraction(chatId: string): Promise<Extract<ChatDeleteOutcome, { status: 503 }> | null> {
	if (!extractionStatuses().some((run) => run.chatId === chatId)) return null;
	abortExtraction(chatId);
	const deadline = Date.now() + WIND_DOWN_TIMEOUT_MS;
	while (extractionStatuses().some((run) => run.chatId === chatId)) {
		if (Date.now() > deadline) {
			return {
				ok: false,
				status: 503,
				code: "extraction_winding_down",
				error: "The session's extraction is still winding down — try again in a moment",
			};
		}
		await new Promise((resolve) => setTimeout(resolve, WIND_DOWN_POLL_MS));
	}
	return null;
}

export type PromptUndoOutcome =
	| { ok: false; status: 404 | 400 | 409 | 503; error: string }
	| { ok: true; text: string; stats: ChatDeletionStats; graphRevision: number; memoriesRemoved: number };

/**
 * Undo the last prompt (owner, 2026-11-10): wind down this chat's
 * extraction, then in ONE synchronous block purge the graph traces of the
 * removed messages, drop their coverage rows, and truncate the record —
 * the deleteChatSession atomicity argument, scoped to messages. Usage
 * logs stay: that spend really happened.
 */
export async function undoLastPrompt(chatId: string, promptId: string): Promise<PromptUndoOutcome> {
	const gate = (): PromptUndoOutcome | null => {
		const record = stores.chatStore.getChat(chatId);
		if (!record) return { ok: false, status: 404, error: "No such session" };
		if (isTurnRunning(chatId)) return { ok: false, status: 409, error: "A turn is running in this session — try again when it finishes" };
		if (undoableTail(record.messages)?.promptId !== promptId) return { ok: false, status: 400, error: "This message can no longer be undone" };
		return null;
	};
	const early = gate();
	if (early) return early;
	const windDown = await windDownExtraction(chatId);
	if (windDown) return { ok: false, status: 503, error: windDown.error };
	// THE SYNC BLOCK — no awaits below. Re-read truth after the wind-down.
	const late = gate();
	if (late) return late;
	const record = stores.chatStore.getChat(chatId)!;
	const tail = undoableTail(record.messages)!;
	const removed = record.messages.slice(tail.cutAt);
	const kept = record.messages.slice(0, tail.cutAt);
	// Memory first: a failed memory write fails Undo before the graph or the
	// transcript is touched. An unreadable memory.json is skipped (Ivan,
	// 2026-11-10); a later settle's reconcile removes the orphans.
	let memoriesRemoved = 0;
	try {
		memoriesRemoved = reconcileMemoryWithChat(chatId, kept);
	} catch (error) {
		if (!(error instanceof MemoryUnavailableError)) throw error;
		console.warn(`[memory] Undo skipped memory: ${error.message}`);
	}
	// Zero-token slots (learner text) share one empty fingerprint: never a coverage key.
	const fps = new Set(coverageSlots(record.messages).slice(tail.cutAt).filter((slot) => slot.tokens > 0).map((slot) => slot.fp));
	const stats = deleteMessageTraces(stores.graphStore, chatId, new Set(removed.map((m) => m.id)), fps);
	stores.chatStore.saveMessages(chatId, kept);
	clearTurnFailure(chatId);
	emit("record-changed", { chatId });
	return { ok: true, text: tail.text, stats, graphRevision: graphRevision(), memoriesRemoved };
}

/** Source deletion has already purged the selected batch's graph traces.
 * Remove the remaining session data with the same gates/cleanup and no await. */
export function deleteIdleChatRecord(chatId: string): Extract<ChatDeleteOutcome, { ok: false }> | { ok: true } {
	if (!stores.chatStore.getChat(chatId)) return { ok: false, status: 404, code: "not_found", error: "No such session" };
	const blocker = runningWorkBlocker(chatId);
	if (blocker) return blocker;
	if (extractionStatuses().some((run) => run.chatId === chatId)) return { ok: false, status: 503, code: "extraction_winding_down", error: "The session's extraction is still winding down — try again in a moment" };
	finishChatRecordDeletion(chatId);
	// ChatStore can swallow unlink failures. Do not tell source deletion to
	// discard placement/folders while the conversation still exists.
	if (stores.chatStore.getChat(chatId)) throw new Error("Could not remove the selected session record.");
	return { ok: true };
}

function finishChatDeletion(chatId: string, mode: ChatDeleteMode): Extract<ChatDeleteOutcome, { ok: true }> {
	// THE SYNC BLOCK — no awaits below (see the doc comment). Order:
	// ledgers → jobs → the chat record.
	const stats = deleteChatTraces(stores.graphStore, chatId, mode);
	const jobsRemoved = finishChatRecordDeletion(chatId);
	return { ok: true, mode, stats, jobsRemoved, graphRevision: graphRevision() };
}

function finishChatRecordDeletion(chatId: string): number {
	const jobsRemoved = stores.jobStore.deleteJobsForChat(chatId);
	if (stores.chatStore.deleteChat(chatId)) {
		discardChatDeliveries(chatId);
		clearTurnFailure(chatId);
		sideChats.stopAll(chatId); // a running side answer has nowhere left to land
	}
	return jobsRemoved;
}

/** One session's coverage read (extraction-UX redesign, owner dispatch
 *  2026-09-24): the chat view's ring meter + popover data, scoped to one
 *  chat (the all-sessions GET died with this redesign — nothing consumed
 *  it once the sidebar and ring read here; the Extract POST stays).
 *  Uncovered stays DERIVED per request (fingerprint the transcript,
 *  diff the coverage ledger — never dual-tracked).
 *
 *  lastFoldedAt: the newest coverage row's fold timestamp — a cheap single
 *  pass over the chat's ledger rows (the ring popover's "last extraction"
 *  line); null before the session's first fold. */
export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	/** True while a chat-kind extraction run is registered for this session. */
	running: boolean;
	/** ISO of the newest fold in this session's coverage rows; null before any. */
	lastFoldedAt: string | null;
}

/** The per-session coverage block (see SessionCoverage). Null when the
 *  chat doesn't exist — callers own the 404. */
export function sessionCoverage(chatId: string): SessionCoverage | null {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return null;
	const entries = stores.graphStore.readCoverage();
	// Wave B: the record is native history — coverage reads through the
	// projection (same view the extraction pipeline folds).
	const cov = coverageOf(record.messages, entries, chatId);
	let lastFoldedAt: string | null = null;
	for (const entry of entries) {
		if (entry.chatId !== chatId) continue;
		if (lastFoldedAt === null || entry.foldedAt > lastFoldedAt) lastFoldedAt = entry.foldedAt;
	}
	return {
		totalMessages: cov.slots.length,
		coveredCount: cov.coveredCount,
		uncoveredCount: cov.uncoveredCount,
		coveredTokens: cov.coveredTokens,
		uncoveredTokens: cov.uncoveredTokens,
		running: extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId),
		lastFoldedAt,
	};
}
