/**
 * Learner memory (docs/superpowers/plans/2026-11-10-learner-memory.md):
 * what the app remembers about the learner between sessions. Separate from
 * the knowledge graph. Stored as one file (config.MEMORY_FILE).
 */

export type MemoryKind = "knowledge" | "thinking" | "mistake" | "preference";

export type MemoryLevel = "profile" | "subject" | "area";

/** One piece of evidence. With `text`, it also sets the memory's wording. */
export interface MemoryEntry {
	at: string; // ISO timestamp
	by: "agent" | "learner"; // learner = Settings panel
	/** Where it was seen. Absent for Settings entries.
	 *  ref = the remember tool-call id. */
	source?: { chatId: string; ref: string };
	/** One line: what he said or did. */
	note: string;
	stance: "confirm" | "contradict";
	/** Present when this entry sets the wording. */
	text?: string;
}

export interface Memory {
	id: string; // "m_" + 6 base36 chars
	kind: MemoryKind;
	subject?: string; // absent = Profile
	area?: string; // requires subject
	entries: MemoryEntry[]; // never empty; at least one has text
	/** Ivan moved it by hand in Settings. */
	placedByLearner?: boolean;
}

export interface MemoryFile {
	version: 1;
	memories: Memory[];
	/** subject → area → one-line description */
	areas: Record<string, Record<string, string>>;
}

/** Where one evidence entry points, resolved for Settings. */
export type MemoryEvidenceWhere =
	| { chatId: string; chatTitle: string; messageId: string | null }
	| "deleted"
	| "settings";

export interface MemoryRow {
	id: string;
	kind: MemoryKind;
	text: string;
	/** ISO of the last entry. */
	at: string;
	placedByLearner?: boolean;
	evidence: { at: string; by: MemoryEntry["by"]; note: string; where: MemoryEvidenceWhere }[];
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
