/**
 * POST /api/images/prepare — raw image bytes in, one normalized native image
 * block out. The browser calls it the moment a picture is attached to an
 * answer, so the original file is never needed again.
 */
import { MAX_ATTACHED_IMAGE_BYTES, prepareAttachedImage } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const refuse = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
	const tooLarge = () => refuse("That image is larger than 25 MB.", 413);
	if (Number(request.headers.get("content-length")) > MAX_ATTACHED_IMAGE_BYTES) return tooLarge();
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.length > MAX_ATTACHED_IMAGE_BYTES) return tooLarge();
	try {
		return Response.json(await prepareAttachedImage(bytes), { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return refuse(error instanceof Error ? error.message : "Could not process this image.", 422);
	}
}
