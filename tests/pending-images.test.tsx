/**
 * Pictures attached to an answer field (owner, 2026-11-13): captured as real
 * image data the moment they are attached, held in memory per field, sent
 * with the submission and cleared only once the server accepted them.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { attachImages, clearPendingImages, isImageFile, PendingImages, removePendingImage, takePendingImages } from "../components/pending-images.tsx";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A stand-in for an editor inside (or outside) an element carrying data-image-field. */
const inField = (field?: string) => ({ closest: () => field ? { getAttribute: () => field } : null }) as unknown as Element;
const file = (name: string, type = "") => new File(["bytes"], name, { type });
function serve(reply: (body: File) => Response | Promise<Response>) {
	const seen: File[] = [];
	globalThis.fetch = (async (url: string, init: { body: File }) => { assert.equal(url, "/api/images/prepare"); seen.push(init.body); return reply(init.body); }) as never;
	return seen;
}
const ok = () => Response.json({ data: "AAAA", mimeType: "image/jpeg" });
let n = 0;
const fresh = () => `thinking:test-${++n}`;

describe("pending images", () => {
	it("recognizes the formats the prepare route accepts, HEIC by name when the browser gives no type", () => {
		assert.ok(isImageFile(file("a.png", "image/png")));
		assert.ok(isImageFile(file("IMG_0042.HEIC")));
		assert.ok(!isImageFile(file("notes.pdf", "application/pdf")));
		assert.ok(!isImageFile(file("diagram.svg", "image/svg+xml")), "SVG is text the agent reads by path");
	});

	it("takes pictures into the field and hands every other file back for the path flow", async () => {
		const field = fresh(), seen = serve(ok);
		const photo = file("photo.jpg", "image/jpeg"), pdf = file("notes.pdf", "application/pdf");
		assert.deepEqual(attachImages(inField(field), [photo, pdf]), [pdf]);
		assert.deepEqual(await takePendingImages(field), [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }]);
		assert.deepEqual(seen, [photo], "the bytes are uploaded at attach time, so the source file may vanish");
		assert.match(renderToStaticMarkup(<PendingImages field={field} />), /src="data:image\/jpeg;base64,AAAA"[^>]*alt="photo\.jpg"|alt="photo\.jpg"[^>]*src="data:image\/jpeg;base64,AAAA"/);
	});

	it("outside an image field every file stays a path and nothing is uploaded", async () => {
		const seen = serve(ok), photo = file("photo.jpg", "image/jpeg");
		assert.deepEqual(attachImages(inField(), [photo]), [photo]);
		assert.deepEqual(attachImages(null, [photo]), [photo]);
		assert.equal(seen.length, 0);
	});

	it("a submission waits for a picture still being prepared", async () => {
		const field = fresh();
		let release!: () => void;
		serve(() => new Promise<Response>(resolve => { release = () => resolve(ok()); }));
		attachImages(inField(field), [file("slow.png", "image/png")]);
		const taken = takePendingImages(field);
		assert.equal(await Promise.race([taken, Promise.resolve("waiting")]), "waiting");
		release();
		assert.equal((await taken).length, 1);
	});

	it("clears exactly the pictures a submission carried; later ones and other fields stay", async () => {
		const field = fresh(), other = fresh();
		serve(ok);
		attachImages(inField(field), [file("one.png", "image/png")]);
		attachImages(inField(other), [file("other.png", "image/png")]);
		const sent = await takePendingImages(field);
		attachImages(inField(field), [file("two.png", "image/png")]);
		clearPendingImages(field, sent);
		const left = await takePendingImages(field);
		assert.equal(left.length, 1);
		assert.ok(!sent.includes(left[0]!));
		assert.equal((await takePendingImages(other)).length, 1);
	});

	it("a refused picture is dropped and the reason is shown in the field", async () => {
		const field = fresh();
		serve(() => Response.json({ error: "Not a supported image (JPG, PNG, GIF, WebP, BMP or HEIC)." }, { status: 422 }));
		attachImages(inField(field), [file("broken.png", "image/png")]);
		assert.deepEqual(await takePendingImages(field), []);
		assert.match(renderToStaticMarkup(<PendingImages field={field} />), /Not a supported image/);
	});

	it("a picture removed while it is being prepared stays removed", async () => {
		const field = fresh();
		let release!: () => void;
		serve(() => new Promise<Response>(resolve => { release = () => resolve(ok()); }));
		attachImages(inField(field), [file("gone.png", "image/png")]);
		assert.match(renderToStaticMarkup(<PendingImages field={field} />), /Remove gone\.png/, "shown with its remove button while preparing");
		removeOnly(field);
		release();
		assert.deepEqual(await takePendingImages(field), []);
	});
});

/** Remove the field's single entry without knowing its id: ids only grow, so scan a small recent window. */
function removeOnly(field: string) { for (let id = 1; id < 200; id++) removePendingImage(field, id); }
