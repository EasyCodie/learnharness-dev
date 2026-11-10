/**
 * Undo / Edit of the last prompt (owner, 2026-11-10). The learner's last
 * typed message — never an earlier one — can be taken back once the turn
 * it started has ended (finished, aborted or failed), provided that turn
 * changed nothing outside the transcript. Undo
 * deletes the prompt and everything after it from the record (the graph
 * purge and coverage rows are the server's choreography); Edit is Undo
 * followed by an ordinary send of the edited text.
 *
 * One check serves both the UI gate and the route, so the button never
 * offers what the server refuses.
 */

import { SEND_TO_USER_TOOL, type LhMessage } from "./native-messages.ts";

/** Tools whose calls leave nothing behind but their transcript messages.
 * Anything else (jobs, plan, quiz/probe/problem, conclude, file writers)
 * makes the turn ineligible. */
const SIDE_EFFECT_FREE_TOOLS = new Set([
	"read", "ls", "grep", "find",
	"pdf", "pdf_info", "pdf_search", "pdf_extract", "pdf_render",
	"web_search", "web_fetch", "web_fetch_pdf",
	"compute", "show_image", "render_svg",
	// The Claude Code runtime's learner-facing reply channel: display only.
	SEND_TO_USER_TOOL,
	"list_sessions", "list_propositions", "find_candidates",
	// Learner memory: Undo reverses their effects itself (the memory reconcile
	// in server/chats.ts undoLastPrompt drops entries citing removed calls).
	"memory_subject", "memory_read", "remember",
]);

export interface UndoableTail {
	/** The prompt's message id (what the client names in the request). */
	promptId: string;
	/** The prompt text, restored to the composer or the inline editor. */
	text: string;
	/** Index of the first message to delete (the prompt, or the synthetic
	 *  dismissal pair that rode in with it). */
	cutAt: number;
}

/** The undoable tail of a record, or null when Undo/Edit must not show. */
export function undoableTail(messages: readonly LhMessage[]): UndoableTail | null {
	let i = messages.length - 1;
	const last = messages[i];
	if (!last || last.role !== "assistant") return null;
	for (; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant") {
			if (m.content.some((b) => b.type === "toolCall" && !SIDE_EFFECT_FREE_TOOLS.has(b.name))) return null;
			continue;
		}
		if (m.role === "toolResult") {
			if (!SIDE_EFFECT_FREE_TOOLS.has(m.toolName)) return null;
			continue;
		}
		break;
	}
	const prompt = messages[i];
	// Only typed text (string content); markers, compaction, answers and
	// structured content all end the walk ineligible.
	if (!prompt || prompt.role !== "user" || typeof prompt.content !== "string") return null;
	// The synthetic conclude pair a problem dismissal adds ahead of the next
	// text input: removing it re-arms the pending dismissal for the resend.
	const pairCall = messages[i - 2];
	const pairResult = messages[i - 1];
	const ridesPair =
		pairCall?.role === "assistant" &&
		pairCall.model === "synthetic-conclude" &&
		pairResult?.role === "toolResult" &&
		pairResult.toolCallId.startsWith("call_conc_");
	return { promptId: prompt.id, text: prompt.content, cutAt: ridesPair ? i - 2 : i };
}
