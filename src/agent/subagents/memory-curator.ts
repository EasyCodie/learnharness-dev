/**
 * The learner-memory curator (plan: docs/superpowers/plans/2026-11-10-learner-memory.md,
 * task 13): a background pass over the part of a session it has not read,
 * built on runSubmitAgent like the extractor. One submit call carries every
 * operation; the rules (evidence, question keys, the flawed-model bar,
 * promotion) are enforced by core/memory.ts applyCuratorOps at the submit
 * seam, so a refused submit comes back to the curator to fix.
 *
 * Never imports the store or server layers: the memory file arrives through
 * `readFile` (fresh at each validation), the graph through its tool context.
 */

import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { prepareAuditorReview, type GraphToolContext } from "../tools/graph.ts";
import { getGraph } from "../../core/graph.ts";
import { applyCuratorOps, curatorMemoryText, resolveName, subjectsOf, type CuratorContext, type CuratorSubmit } from "../../core/memory.ts";
import type { MemoryFile } from "../../core/contracts/memory.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { sessionMarkdown } from "../../core/session-markdown.ts";

/** The approved curator system prompt (plan, "Prompt text"). */
export const CURATOR_INSTRUCTIONS = `You maintain a long-term memory of one learner. You are given part of a finished teaching or practice session, with message ids, and what is already remembered for this subject. Record only what the session shows about the learner: what he holds and where it runs out (knowledge), how he reasons about the material (thinking model), and where he loses marks and on which kind of question (mistake pattern).

Every item must cite the message ids of the answered questions or concluded problems that show it, with one line each saying what he did. Cite the question, not your commentary on it. If an existing memory or note already describes what you see, add a sighting to it, confirming or contradicting, instead of writing a new one. Revise a memory's wording only when the evidence shows it has changed. A single slip is still worth recording as one sighting; the system decides when sightings become a memory. Write each memory as one specific sentence that would help a tutor next month. File it under the area where it is true, reusing existing area names. Link knowledge memories to proposition ids when the graph tools show a clear match. If the session shows nothing worth recording, submit no items.

You are also given the mistake patterns recorded under his other subjects. If a slip in this session is the same underlying mistake as one of them, add your sighting to that memory instead of writing a new one. When the same mistake is an established pattern in two subjects, promote it to the Profile: name every memory that describes it and give one wording that does not mention a subject. The system refuses a promotion that lacks the evidence and tells you what is missing; do not promote while the Profile is full.

Mark every thinking model as sound (reasoning that works and that a tutor can build on) or flawed. Recording a flawed model is an accusation about how he thinks, and a wrong one does real damage, so the standard is proof, not suspicion. Record a sighting of flawed reasoning only when his own words in the cited message state the faulty step, and quote those words exactly; the system rejects a quote it cannot find in his text. A correct answer reached through such reasoning is a sighting of the flawed model, not of knowledge. A wrong answer alone is never a sighting of flawed reasoning. Do not count an answer with no thinking given, terse shorthand, speech-to-text noise, a slip of wording, low confidence, or an unusual method that is valid. If any innocent reading fits, record nothing. When he later reasons soundly on the same point, record a contradicting sighting. The same applies across subjects: a flawed model is promoted only when it is established in two subjects.`;

export const CURATOR_SUBMIT_TOOL = "submit_memory";

const evidence = Type.Array(
	Type.Object({
		ref: Type.String({ minLength: 1, description: "A message id from the session part (the id after · in a heading)." }),
		note: Type.String({ minLength: 1, description: "One line: what he did there." }),
		quote: Type.Optional(Type.String({ description: "Flawed thinking models: his own words from that message, verbatim, at least 20 characters." })),
	}),
	{ minItems: 1 },
);

const submitSchema = Type.Object({
	subject: Type.String({ description: "The subject to file under: this session's subject, or as the input says." }),
	newSubject: Type.Optional(Type.Boolean({ description: "true to create the subject named in subject." })),
	ops: Type.Array(
		Type.Union([
			Type.Object({
				op: Type.Literal("new"),
				kind: Type.Union([Type.Literal("knowledge"), Type.Literal("thinking"), Type.Literal("mistake")]),
				area: Type.String({ minLength: 1, description: "An existing area name, or a new one with newAreaDescription." }),
				newAreaDescription: Type.Optional(Type.String({ description: "Required for a new area: one line saying what it covers." })),
				text: Type.String({ minLength: 1, description: "The memory: one specific sentence." }),
				flawed: Type.Optional(Type.Boolean({ description: "Required for kind thinking: true = flawed model, false = sound model." })),
				graphNodeIds: Type.Optional(Type.Array(Type.String(), { description: "Knowledge only: proposition ids from the graph tools." })),
				evidence,
			}),
			Type.Object({
				op: Type.Literal("sighting"),
				id: Type.String({ minLength: 1, description: "An existing memory id." }),
				stance: Type.Union([Type.Literal("confirm"), Type.Literal("contradict")]),
				evidence,
			}),
			Type.Object({
				op: Type.Literal("revise"),
				id: Type.String({ minLength: 1 }),
				text: Type.String({ minLength: 1, description: "The new wording." }),
				evidence,
			}),
			Type.Object({
				op: Type.Literal("promote"),
				ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Every memory that describes this mistake (all mistake patterns, or all flawed thinking models)." }),
				text: Type.String({ minLength: 1, description: "One wording that does not mention a subject." }),
				evidence,
			}),
		]),
		{ description: "Empty when the session shows nothing worth recording." },
	),
});

const SUBMIT_DESCRIPTION =
	"Submit everything this pass records, once. ops apply in order (a sighting before a promote counts toward it). " +
	"Every evidence ref must be a message id from the session part: his answered check, the concluded problem, his thinking submission, or his own message; never a tutor message. " +
	"new: a memory filed under an area of the subject. sighting: add evidence to an existing memory (confirm or contradict). revise: new wording for an existing memory. " +
	"promote: merge mistake patterns (or flawed thinking models) established in two subjects into one Profile memory. " +
	"A refusal lists every problem; fix them and submit again. ops: [] is a valid submit.";

export interface CuratorRunInput {
	chatId: string;
	kind: "teach" | "practice";
	/** The whole saved record. */
	messages: readonly LhMessage[];
	/** Index of the first message the curator has not read. */
	spanStart: number;
	/** Fresh read of memory.json (the port; read again at each validation). */
	readFile: () => MemoryFile;
	/** The session's subject from the transcript, if set. */
	sessionSubject: string | null;
	/** Present when the graph tools are on. */
	graph?: GraphToolContext;
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
	now?: Date;
}

/** The subject lines of the curator's input (plan Default 60). */
function subjectInstructions(file: MemoryFile, sessionSubject: string | null): string {
	const subjects = subjectsOf(file);
	if (!sessionSubject) return `This session's subject: not set. Set subject to one of the existing subjects (${subjects.join(", ") || "none"}) if it is the same subject, or name it with newSubject: true.`;
	const bound = resolveName(subjects, sessionSubject);
	if (bound || subjects.length === 0) return `This session's subject: ${bound ?? sessionSubject}. Set subject to "${bound ?? sessionSubject}"${bound ? "" : " with newSubject: true"}.`;
	return `This session's subject: ${sessionSubject}, which holds no memories yet. Other subjects exist: ${subjects.join(", ")}. Set subject to one of them if it is the same subject, or to "${sessionSubject}" with newSubject: true.`;
}

export function curatorPrompt(input: Pick<CuratorRunInput, "kind" | "messages" | "spanStart" | "sessionSubject">, file: MemoryFile, now: Date): string {
	const span = input.messages.slice(input.spanStart);
	return [
		`Session kind: ${input.kind === "practice" ? "practice" : "teaching"}.`,
		subjectInstructions(file, input.sessionSubject),
		`## What is remembered\n\n${curatorMemoryText(file, resolveName(subjectsOf(file), input.sessionSubject ?? "") ?? input.sessionSubject, now)}`,
		`## The session part to record (message ids after ·)\n\n${sessionMarkdown(span, { anchors: true, context: input.messages }) || "(nothing new)"}`,
	].join("\n\n");
}

/** Run one pass; resolves with the validated submit (ops may be empty). */
export async function runMemoryCurator(input: CuratorRunInput): Promise<CuratorSubmit> {
	const now = input.now ?? new Date();
	const span = new Set(input.messages.slice(input.spanStart).map((m) => m.id));
	const graphIds = input.graph ? new Set(getGraph(input.graph.graphStore).nodes.map((n) => n.id)) : undefined;
	const ctx: CuratorContext = {
		chatId: input.chatId,
		messages: input.messages,
		span,
		sessionSubject: input.sessionSubject,
		at: now.toISOString(),
		...(graphIds ? { graphHas: (id: string) => graphIds.has(id) } : {}),
	};
	// The auditor's readers print proposition ids; find_candidates needs its own batch.
	const extraTools: Record<string, AgentTool<any>> | undefined = input.graph
		? (({ list_sessions, list_propositions }) => ({ list_sessions: list_sessions!, list_propositions: list_propositions! }))(prepareAuditorReview(input.graph).tools)
		: undefined;
	return runSubmitAgent<CuratorSubmit>({
		role: "curator",
		toolName: CURATOR_SUBMIT_TOOL,
		toolDescription: SUBMIT_DESCRIPTION,
		parameters: submitSchema,
		fill: (raw) => ({ ...raw, ops: raw.ops ?? [] }),
		systemPrompt: CURATOR_INSTRUCTIONS,
		prompt: curatorPrompt(input, input.readFile(), now),
		engine: input.engine,
		signal: input.signal,
		onStep: (usage, model) => input.onStep?.(usage, model),
		neverSubmitted: "the memory curator never submitted",
		...(extraTools ? { extraTools } : {}),
		maxTurns: extraTools ? 16 : 6,
		chatId: input.chatId,
		validate: (value) => {
			const result = applyCuratorOps(input.readFile(), value, ctx);
			return "problems" in result ? result.problems.join("\n") : null;
		},
	});
}
