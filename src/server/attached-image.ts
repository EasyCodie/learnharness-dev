import { detectSupportedImageMimeType, processImage } from "../agent/image-processing/index.ts";
import { heicBytesToJpeg, isHeic } from "../agent/image-processing/heic.ts";

export const MAX_ATTACHED_IMAGE_BYTES = 25 * 1024 * 1024;

/** One picture the learner attached → the normalized native block the
 * submission path accepts. Captured at attach time, so the source file may
 * vanish afterwards; submission admission still re-validates these bytes. */
export async function prepareAttachedImage(bytes: Uint8Array): Promise<{ data: string; mimeType: string }> {
	if (isHeic(bytes)) bytes = await heicBytesToJpeg(bytes);
	const mime = detectSupportedImageMimeType(bytes);
	if (!mime) throw new Error("Not a supported image (JPG, PNG, GIF, WebP, BMP or HEIC).");
	const result = await processImage(bytes, mime);
	if (!result.ok) throw new Error("Could not process this image.");
	return { data: result.data, mimeType: result.mimeType };
}
