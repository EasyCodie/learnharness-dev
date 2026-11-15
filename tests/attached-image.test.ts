/** Attached pictures: raw bytes → the normalized native image block (route + pipeline). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { preparePluginSubmissionImage } from "../src/core/plugin-submissions.ts";

const { POST } = await import("../app/api/images/prepare/route.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attached-image-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function png(width: number, height: number): Buffer {
	const canvas = createCanvas(width, height);
	canvas.getContext("2d").fillRect(0, 0, width, height);
	return canvas.toBuffer("image/png");
}
const post = (body: Buffer, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/images/prepare", { method: "POST", body: new Blob([new Uint8Array(body)]), headers }));

describe("POST /api/images/prepare", () => {
	it("returns a native image block the submission validator accepts", async () => {
		const response = await post(png(40, 30));
		assert.equal(response.status, 200);
		const image = await response.json() as { data: string; mimeType: string };
		assert.equal(image.mimeType, "image/png");
		assert.doesNotThrow(() => preparePluginSubmissionImage({ type: "image", ...image }));
	});

	it("shrinks an oversized picture to the pipeline's 2000px bound", async () => {
		const image = await (await post(png(3000, 1000))).json() as { data: string; mimeType: string };
		const out = path.join(tmp, "big");
		fs.writeFileSync(out, Buffer.from(image.data, "base64"));
		const width = Number(/pixelWidth: (\d+)/.exec(execFileSync("/usr/bin/sips", ["-g", "pixelWidth", out]).toString())?.[1]);
		assert.equal(width, 2000);
	});

	it("converts a HEIC photo (iPhone default) on macOS", { skip: process.platform !== "darwin" }, async () => {
		const source = path.join(tmp, "photo.png"), heic = path.join(tmp, "photo.heic");
		fs.writeFileSync(source, png(64, 48));
		execFileSync("/usr/bin/sips", ["-s", "format", "heic", source, "--out", heic], { stdio: "ignore" });
		const response = await post(fs.readFileSync(heic));
		assert.equal(response.status, 200);
		assert.equal((await response.json() as { mimeType: string }).mimeType, "image/jpeg");
	});

	it("refuses bytes that are not an image, and oversized uploads", async () => {
		const bad = await post(Buffer.from("not a photo"));
		assert.equal(bad.status, 422);
		assert.match((await bad.json() as { error: string }).error, /Not a supported image/);
		assert.equal((await post(Buffer.from("x"), { "content-length": String(26 * 1024 * 1024) })).status, 413);
	});
});
