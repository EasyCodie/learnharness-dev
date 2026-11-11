/**
 * The curator's "remembered: …" lines for one chat (learner memory plan
 * 2026-11-10, Default 25): GET ?chatId= → { notices: [{ memoryId, text,
 * anchor }] }. Derived on read, so a deleted or undone memory loses its line.
 */
import { readMemoryNotices } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const chatId = new URL(request.url).searchParams.get("chatId") ?? "";
	return Response.json({ notices: chatId ? readMemoryNotices(chatId) : [] });
}
