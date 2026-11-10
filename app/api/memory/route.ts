/**
 * Settings → Memory (learner memory plan, 2026-11-10).
 *   GET  → the memory tree with each evidence line resolved to its session.
 *   POST → add a memory by hand ({ kind, level, subject?, newSubject?, area?,
 *          newAreaDescription?, text }). 400 on refusal, 503 when memory.json
 *          cannot be read.
 */
import { addMemory, readMemoryView } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(readMemoryView());
}

export async function POST(request: Request) {
	const outcome = addMemory(await request.json().catch(() => null));
	return outcome.ok ? Response.json(outcome.value) : Response.json({ error: outcome.error }, { status: outcome.status });
}
