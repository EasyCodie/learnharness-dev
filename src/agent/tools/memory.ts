import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore, MemoryStore } from "../../core/ports.ts";
import { applyRemember, areaContents, areasOf, resolveName, sessionSubject, subjectIndex, subjectsOf } from "../../core/memory.ts";

/**
 * The learner-memory tools (plan: docs/superpowers/plans/2026-11-10-learner-memory.md).
 * Descriptions carry mechanics only; when and what to save is in the memory
 * doctrine that travels with the prompt block (core/memory.ts). A refusal
 * throws, so the model gets an error result and retries.
 */

export interface MemoryToolContext {
	chatId: string;
	/** Seeds the session subject from the saved record. */
	chatStore: Pick<ChatStore, "getChat">;
	memoryStore: MemoryStore;
	/** The server emits "memory-changed". */
	onChange: () => void;
}

const subjectInput = Type.Object({
	subject: Type.String({ minLength: 1, description: "The session's subject, e.g. \"Economics\"." }),
	new: Type.Optional(Type.Boolean({ description: "true when no existing subject is the same subject." })),
});

const readInput = Type.Object({
	area: Type.String({ minLength: 1, description: "An area name from this subject's area list." }),
});

const rememberInput = Type.Object({
	text: Type.String({ minLength: 1, description: "The memory: one specific sentence." }),
	kind: Type.Union([Type.Literal("preference"), Type.Literal("knowledge"), Type.Literal("thinking"), Type.Literal("mistake")], {
		description: "preference covers preferences and goals.",
	}),
	level: Type.Union([Type.Literal("profile"), Type.Literal("subject"), Type.Literal("area")], {
		description: "profile = everything he studies; subject = the session's subject; area = one area of it.",
	}),
	area: Type.Optional(Type.String({ description: "Required when level is \"area\". Reuse an existing area name." })),
	newAreaDescription: Type.Optional(Type.String({ description: "Required to create a new area: one line saying what it covers." })),
	replaces: Type.Optional(Type.String({ description: "The id of a memory this one updates or corrects. The text becomes its new wording; it stays where it is filed." })),
	confirmNew: Type.Optional(Type.Boolean({ description: "true after a refusal listed this area's memories and none of them says this." })),
	note: Type.String({ minLength: 1, description: "One line: what he said that this memory records." }),
});

export function memoryTools(ctx: MemoryToolContext): Record<string, AgentTool<any>> {
	// Turn-scoped: the saved record does not change during a turn, so a
	// memory_subject → remember pair in one run shares this closure.
	let subject: string | null | undefined;
	// A subject that holds no memories yet counts as new only in the turn
	// where memory_subject accepted it: subjects may have appeared since an
	// earlier turn, so the first save re-checks against the current list.
	let acceptedNewThisTurn = false;
	const currentSubject = () => (subject === undefined ? (subject = sessionSubject(ctx.chatStore.getChat(ctx.chatId)?.messages ?? [])) : subject);

	const memorySubject: AgentTool<typeof subjectInput> = {
		name: "memory_subject",
		label: "memory_subject",
		description:
			"Set this session's subject and get its memories and area list. Calling it again switches the subject. " +
			"A name that matches no existing subject (case-insensitive) is refused with the subject list; repeat with an existing name, or with new: true.",
		parameters: subjectInput,
		executionMode: "sequential",
		execute: serverExecute("memory_subject", subjectInput, (input) => {
			const file = ctx.memoryStore.read();
			const existing = subjectsOf(file);
			const name = resolveName(existing, input.subject) ?? (input.new ? input.subject.trim() : null);
			if (!name) {
				throw new Error(
					`No subject named "${input.subject.trim()}". Existing subjects: ${existing.join(", ") || "none"}. ` +
						"Call again with one of these names if it is the same subject, or with new: true.",
				);
			}
			subject = name;
			acceptedNewThisTurn = !existing.includes(name);
			return { text: subjectIndex(file, name), details: { subject: name } };
		}),
	};

	const memoryRead: AgentTool<typeof readInput> = {
		name: "memory_read",
		label: "memory_read",
		description: "Read the memories filed under one area of this session's subject.",
		parameters: readInput,
		executionMode: "sequential",
		execute: serverExecute("memory_read", readInput, (input) => {
			const current = currentSubject();
			if (!current) throw new Error("Set the session's subject with memory_subject first.");
			const file = ctx.memoryStore.read();
			const areas = areasOf(file, current);
			const area = resolveName(areas, input.area);
			if (!area) throw new Error(`No area named "${input.area.trim()}" under ${current}. Areas: ${areas.join(", ") || "none"}.`);
			return areaContents(file, current, area);
		}),
	};

	const remember: AgentTool<typeof rememberInput> = {
		name: "remember",
		label: "remember",
		description:
			"Save a memory about the learner. Subject and area levels file it under this session's subject (set it with memory_subject first). " +
			"Refusals: an unknown area without newAreaDescription; a new memory in an area that already holds memories of the same kind, " +
			"unless replaces or confirmNew is given (the refusal lists them); a Profile save when the Profile is full (the refusal lists it).",
		parameters: rememberInput,
		executionMode: "sequential",
		// shortcut: evidence cites the provider's tool-call id, which matches the
		// saved record except on providers that reuse ids (the call-ids.ts
		// rename). Ivan uses Claude only (2026-11-10); revisit if that changes.
		execute: serverExecute("remember", rememberInput, (input, { toolCallId }) => {
			const file = ctx.memoryStore.read();
			const current = currentSubject();
			const subjects = subjectsOf(file);
			if (input.level !== "profile" && current && !acceptedNewThisTurn && subjects.length > 0 && !resolveName(subjects, current)) {
				throw new Error(
					`This session's subject "${current}" holds no memories yet, and the subject list has changed since it was set. Existing subjects: ${subjects.join(", ")}. ` +
						"Call memory_subject again: reuse one of these names if it is the same subject, or confirm with new: true.",
				);
			}
			const result = applyRemember(
				file,
				{ ...input, subject: current, newSubject: true },
				{ at: new Date().toISOString(), by: "agent", source: { chatId: ctx.chatId, ref: toolCallId } },
			);
			if ("problems" in result) throw new Error(result.problems.join("\n"));
			ctx.memoryStore.write(result.file);
			ctx.onChange();
			return { text: "Saved.", details: { ok: true, id: result.memory.id, text: input.text.trim() } };
		}),
	};

	return { memory_subject: memorySubject, memory_read: memoryRead, remember };
}
