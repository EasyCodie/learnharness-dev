/**
 * The learner-memory curation service (plan: docs/superpowers/plans/2026-11-10-learner-memory.md,
 * task 14). After a turn settles, a curator pass runs in the background
 * when the session reached a milestone since the cursor (core curationDue).
 * One pass per chat at a time; the model call takes a background-LLM slot.
 * The apply step runs in one sync block against the fresh record, so an
 * Undo during the pass drops the ops that cite what it removed.
 */

import { emit } from "../core/events.ts";
import { applyCuratorOps, curationDue, sessionSubject, type CuratorSubmit } from "../core/memory.ts";
import type { CallUsage } from "../core/contracts.ts";
import type { MemoryFile } from "../core/contracts/memory.ts";
import type { PiEngine } from "../agent/models.ts";
import { runMemoryCurator } from "../agent/subagents/memory-curator.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";

export interface CurationDeps {
	/** The curator's engine, or null when no model, key or background permission. */
	engine: () => PiEngine | null;
}

interface CurationGlobal {
	__lhCurationRuns?: Set<string>;
	/** chat → the last message of a span whose pass failed: the next pass
	 *  waits for a new milestone after it (not every settle). */
	__lhCurationFailedAt?: Map<string, string>;
}
const running = (): Set<string> => ((globalThis as CurationGlobal).__lhCurationRuns ??= new Set());
const failedAt = (): Map<string, string> => ((globalThis as CurationGlobal).__lhCurationFailedAt ??= new Map());

/** Start a pass in the background unless one is already running for this chat.
 *  A finished pass re-checks, so milestones reached meanwhile are not lost. */
export function triggerCuration(chatId: string, deps: CurationDeps): void {
	if (running().has(chatId)) return;
	running().add(chatId);
	void curateChat(chatId, deps)
		.then((outcome) => {
			running().delete(chatId);
			if (outcome === "done") triggerCuration(chatId, deps);
		})
		.catch((error) => {
			running().delete(chatId);
			console.error(`[memory] curation failed for ${chatId}:`, error);
		});
}

/** One pass. Exported for tests. */
export async function curateChat(chatId: string, deps: CurationDeps, signal?: AbortSignal): Promise<"not-due" | "skipped" | "done" | "failed"> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return "not-due";
	let file: MemoryFile;
	try {
		file = stores.memoryStore.read();
	} catch (error) {
		console.warn(`[memory] curation skipped for ${chatId}: ${(error as Error).message}`);
		return "skipped";
	}
	const cursor = file.cursors?.[chatId];
	if (!curationDue(record.messages, cursor)) return "not-due";
	// After a failed pass, retry at the next milestone, not at every settle.
	const failed = failedAt().get(chatId);
	if (failed !== undefined && record.messages.some((m) => m.id === failed) && !curationDue(record.messages, failed)) return "not-due";
	const engine = deps.engine();
	if (!engine) {
		// The cursor stays, so the next milestone retries.
		console.info(`[memory] curation skipped for ${chatId}: no curator model, key or background permission`);
		return "skipped";
	}
	const spanStart = cursor === undefined ? 0 : record.messages.findIndex((m) => m.id === cursor) + 1;
	const span = new Set(record.messages.slice(spanStart).map((m) => m.id));
	const subject = sessionSubject(record.messages);
	const startedAt = Date.now();
	const steps: CallUsage[] = [];
	let model = `${engine.model.provider}:${engine.model.id}`;
	let ops: number | undefined;
	try {
		// Per-request worker admission (runSubagent) replaced the old slot semaphore.
		const submit = await runMemoryCurator({
				chatId,
				kind: record.kind === "practice" ? "practice" : "teach",
				messages: record.messages,
				spanStart,
				readFile: () => stores.memoryStore.read(),
				sessionSubject: subject,
				engine,
				signal,
				onStep: (usage, stepModel) => {
					steps.push(callUsage(usage));
					model = stepModel;
				},
			});
		ops = applyCuration(chatId, submit, span, subject);
		failedAt().delete(chatId);
		return "done";
	} catch (error) {
		console.error(`[memory] curator pass failed for ${chatId}:`, error);
		failedAt().set(chatId, record.messages.at(-1)!.id);
		return "failed";
	} finally {
		if (steps.length > 0 && stores.chatStore.getChat(chatId)) {
			stores.chatStore.appendCurationUsage(chatId, { startedAt, at: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, model, steps, ...(ops !== undefined ? { ops } : {}) });
		}
	}
}

/** The apply step, in one sync block: re-read the record and the memory
 *  file, drop evidence the record no longer holds, apply op by op (an op
 *  that no longer validates is skipped), advance the cursor. Returns the
 *  number of ops applied. */
function applyCuration(chatId: string, submit: CuratorSubmit, span: ReadonlySet<string>, subject: string | null): number {
	const fresh = stores.chatStore.getChat(chatId);
	if (!fresh) return 0;
	const present = new Set(fresh.messages.map((m) => m.id));
	const kept = new Set([...span].filter((id) => present.has(id)));
	let file = stores.memoryStore.read();
	const ctx = { chatId, messages: fresh.messages, span: kept, sessionSubject: subject, at: new Date().toISOString() };
	let applied = 0;
	for (const op of submit.ops) {
		const evidence = op.evidence.filter((e) => kept.has(e.ref));
		if (evidence.length === 0) continue;
		const result = applyCuratorOps(file, { ...submit, ops: [{ ...op, evidence }] }, ctx);
		if ("problems" in result) {
			console.warn(`[memory] curator op skipped for ${chatId}: ${result.problems.join("; ")}`);
			continue;
		}
		file = result.file;
		applied++;
	}
	const last = [...fresh.messages].reverse().find((m) => kept.has(m.id))?.id;
	if (last) file = { ...file, cursors: { ...file.cursors, [chatId]: last } };
	stores.memoryStore.write(file);
	emit("memory-changed", {});
	return applied;
}
