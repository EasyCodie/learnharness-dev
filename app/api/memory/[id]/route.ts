/**
 * One memory (learner memory plan, 2026-11-10).
 *   PUT    → { text?, kind?, move?: { level, subject?, newSubject?, area?, newAreaDescription? } }
 *   DELETE → remove it.
 */
import { deleteMemory, editMemory } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	const outcome = editMemory(id, await request.json().catch(() => null));
	return outcome.ok ? Response.json(outcome.value) : Response.json({ error: outcome.error }, { status: outcome.status });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	const outcome = deleteMemory(id);
	return outcome.ok ? Response.json(outcome.value) : Response.json({ error: outcome.error }, { status: outcome.status });
}
