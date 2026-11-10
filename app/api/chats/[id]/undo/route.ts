/**
 * Undo the last prompt (owner, 2026-11-10): body { messageId } names the
 * learner's last typed message. The server re-checks eligibility against
 * saved truth (src/core/prompt-undo.ts), purges the removed messages'
 * graph traces, and truncates the record. The response returns the prompt
 * text for the composer or the inline editor.
 */
import { undoLastPrompt } from "@/src/server";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const body = (await req.json().catch(() => null)) as { messageId?: unknown } | null;
	if (typeof body?.messageId !== "string" || body.messageId === "") {
		return Response.json({ error: "messageId must be a non-empty string" }, { status: 400 });
	}
	const outcome = await undoLastPrompt(id, body.messageId);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json(outcome);
}
