/**
 * Rename a subject ({ subject, newName }), rename an area ({ subject, area,
 * newName }) or edit an area's description ({ subject, area, description }).
 * A rename onto an existing name is refused (no silent merge).
 */
import { editAreas } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
	const outcome = editAreas(await request.json().catch(() => null));
	return outcome.ok ? Response.json({ ok: true }) : Response.json({ error: outcome.error }, { status: outcome.status });
}
