/**
 * Learner memory (docs/superpowers/plans/2026-11-10-learner-memory.md):
 * what the app remembers about the learner between sessions. Separate from
 * the knowledge graph. Stored as one file (config.MEMORY_FILE).
 */

export type MemoryKind = "knowledge" | "thinking" | "mistake" | "preference";

export type MemoryLevel = "profile" | "subject" | "area";

/** Derived on read, never stored (plan Default 21). "unconfirmed" is a
 *  curator-created flawed thinking model below the high bar (Default 36). */
export type MemoryStatus = "note" | "active" | "fading" | "faded" | "unconfirmed";

/** One piece of evidence. With `text`, it also sets the memory's wording. */
export interface MemoryEntry {
	at: string; // ISO timestamp
	by: "agent" | "learner" | "curator"; // learner = Settings panel
	/** Where it was seen. Absent for Settings entries.
	 *  ref = the remember tool-call id (in-chat save) or a message id (curator). */
	source?: { chatId: string; ref: string };
	/** One line: what he said or did. */
	note: string;
	stance: "confirm" | "contradict";
	/** Present when this entry sets the wording. */
	text?: string;
	/** Curator entries: the subject of the session it was seen in. */
	subject?: string;
	/** Curator entries: the call id of the check or problem this sighting is
	 *  about (plan Default 54). "Different questions" = distinct values. */
	question?: string;
	/** Sightings of a flawed thinking model: his words, verbatim. */
	quote?: string;
	/** On the entry that moved the memory to the Profile: where it was filed. */
	promotedFrom?: { subject: string; area?: string; areaDescription?: string };
}

export interface Memory {
	id: string; // "m_" + 6 base36 chars
	kind: MemoryKind;
	subject?: string; // absent = Profile
	area?: string; // requires subject
	entries: MemoryEntry[]; // never empty; at least one has text
	/** Ivan moved it by hand in Settings; the curator never moves or merges it. */
	placedByLearner?: boolean;
	/** Knowledge only: linked graph proposition ids. */
	graphNodeIds?: string[];
	/** Thinking only: true = a flawed model, false = a sound one; absent = unmarked. */
	flawed?: boolean;
	/** Ivan set the sound/flawed mark himself in Settings (plan Default 56). */
	markedByLearner?: boolean;
}

export interface MemoryFile {
	version: 1;
	memories: Memory[];
	/** subject → area → one-line description */
	areas: Record<string, Record<string, string>>;
	/** Per chat: the last message id the curator has read. */
	cursors?: Record<string, string>;
}

/** Where one evidence entry points, resolved for Settings. */
export type MemoryEvidenceWhere =
	/** anchor: the hash target in that chat (the remember line, `message-<call id>`); null = open the chat. */
	| { chatId: string; chatTitle: string; anchor: string | null }
	| "deleted"
	| "settings";

export interface MemoryRow {
	id: string;
	kind: MemoryKind;
	text: string;
	/** ISO of the last entry. */
	at: string;
	status: MemoryStatus;
	/** Flawed models on the bar: progress toward it (Default 36). */
	progress?: { questions: number; sessions: number };
	flawed?: boolean;
	placedByLearner?: boolean;
	/** Knowledge: linked propositions that still exist in the graph. */
	propositions?: { id: string; name: string }[];
	evidence: {
		at: string;
		by: MemoryEntry["by"];
		note: string;
		where: MemoryEvidenceWhere;
		stance: MemoryEntry["stance"];
		subject?: string;
		quote?: string;
		promotedFrom?: MemoryEntry["promotedFrom"];
	}[];
}

/** One curator "remembered: …" line (GET /api/memory/notices). anchor: the
 *  cited card's call id or the cited message's id (message-<anchor>). */
export interface MemoryNoticeView {
	memoryId: string;
	text: string;
	anchor: string;
}

/** The Settings → Memory tree (GET /api/memory). */
export interface MemoryView {
	enabled: boolean;
	/** Set when memory.json cannot be read; the tree is then empty. */
	error?: string;
	profileCap: number;
	profile: MemoryRow[];
	subjects: { name: string; memories: MemoryRow[]; areas: { name: string; description: string; memories: MemoryRow[] }[] }[];
}
