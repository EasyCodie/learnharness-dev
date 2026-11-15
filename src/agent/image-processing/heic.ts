import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

/** HEIC/HEIF: an ISO-BMFF `ftyp` box carrying a HEIF brand. */
export function isHeic(bytes: Uint8Array): boolean {
	return /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(Buffer.from(bytes.subarray(4, 12)).toString("latin1"));
}

/** iPhone photos arrive as HEIC, which the image pipeline cannot decode.
 * shortcut: macOS only (sips); add a HEIC decoder if other platforms need it. */
export async function heicFileToJpeg(file: string, signal?: AbortSignal): Promise<Buffer> {
	const out = path.join(os.tmpdir(), `lh-heic-${randomUUID()}.jpg`);
	await fs.access(file); // a missing file fails on its own path, not on the temp output
	try {
		await promisify(execFile)("/usr/bin/sips", ["-s", "format", "jpeg", file, "--out", out], { signal });
		return await fs.readFile(out);
	} catch {
		signal?.throwIfAborted();
		throw new Error("Could not convert this HEIC image to JPEG; the file may be damaged.");
	} finally { await fs.rm(out, { force: true }); }
}

export async function heicBytesToJpeg(bytes: Uint8Array): Promise<Buffer> {
	const file = path.join(os.tmpdir(), `lh-heic-${randomUUID()}.heic`);
	try {
		await fs.writeFile(file, bytes);
		return await heicFileToJpeg(file);
	} finally { await fs.rm(file, { force: true }); }
}
