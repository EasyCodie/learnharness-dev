/**
 * Learner memory on disk (config.MEMORY_FILE): one JSON file, read and
 * rewritten whole through the atomic write. A corrupt file, or one stamped
 * newer than this build, is never overwritten: read() throws and callers
 * treat memory as unavailable.
 */

import fs from "node:fs";
import path from "node:path";
import { MEMORY_FILE } from "../../config.ts";
import type { MemoryFile } from "../core/contracts/memory.ts";
import { MemoryUnavailableError, emptyMemoryFile } from "../core/memory.ts";
import type { MemoryStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

function read(): MemoryFile {
	let raw: string;
	try {
		raw = fs.readFileSync(MEMORY_FILE, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMemoryFile();
		throw new MemoryUnavailableError(`Memory file cannot be read: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new MemoryUnavailableError("Memory file is corrupt (not valid JSON). It was left untouched.");
	}
	const file = parsed as Partial<MemoryFile> | null;
	if (!file || typeof file !== "object" || typeof file.version !== "number" || !Array.isArray(file.memories) || !file.areas || typeof file.areas !== "object") {
		throw new MemoryUnavailableError("Memory file is corrupt (unexpected shape). It was left untouched.");
	}
	if (file.version > 1) throw new MemoryUnavailableError(`Memory file was written by a newer version of LearnHarness (format ${file.version}). It was left untouched.`);
	return file as MemoryFile;
}

function write(file: MemoryFile): void {
	fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
	writeFileAtomicSync(MEMORY_FILE, JSON.stringify(file, null, "\t"));
}

export const memoryStore: MemoryStore = { read, write };
