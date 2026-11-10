/**
 * Learner memory UI (plan 2026-11-10 task 8): the "remembered: …" line, the
 * live card staying silent for the two read tools, and the Settings tree.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveToolCard } from "../components/artifacts/live-tool-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { MemorySection } from "../components/settings/memory-section.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import type { MemoryView } from "../src/core/contracts/memory.ts";

describe("memory transcript cards", () => {
	it("remember settled: one remembered line; nothing for an error", () => {
		const Card = artifactRenderers.remember!;
		const ok = renderToStaticMarkup(<Card part={{ type: "tool-remember", toolCallId: "c", state: "output-available", output: { ok: true, id: "m_ab12cd", text: "Wants a diagram first." } } as never} />);
		assert.match(ok, /remembered: Wants a diagram first\./);
		assert.match(ok, /id="message-c"/, "the evidence link's anchor");
		const failed = renderToStaticMarkup(<Card part={{ type: "tool-remember", toolCallId: "c", state: "output-error", errorText: "refused" } as never} />);
		assert.equal(failed, "");
	});

	it("live: memory_subject and memory_read render nothing; remember shows its label without input", () => {
		const SECRET = "SENTINEL_9431";
		for (const tool of ["memory_subject", "memory_read"]) {
			assert.equal(renderToStaticMarkup(<LiveToolCard part={{ type: `tool-${tool}`, toolCallId: "c", state: "input-streaming", input: { subject: SECRET, area: SECRET } } as never} />), "");
			assert.equal(artifactRenderers[tool], undefined, `${tool} has no settled card`);
		}
		const live = renderToStaticMarkup(<LiveToolCard part={{ type: "tool-remember", toolCallId: "c", state: "input-streaming", input: { text: SECRET } } as never} />);
		assert.match(live, /Remembering…/);
		assert.ok(!live.includes(SECRET));
	});
});

describe("Settings → Memory", () => {
	const view: MemoryView = {
		enabled: true,
		profileCap: 15,
		profile: [
			{
				id: "m_aaaaaa", kind: "preference", text: "Wants a diagram before any algebra.", at: "2026-11-10T09:00:00.000Z",
				evidence: [{ at: "2026-11-10T09:00:00.000Z", by: "agent", note: "He asked for pictures.", where: { chatId: "chat_1", chatTitle: "Waves", anchor: "toolu_1" } }],
			},
			{ id: "m_bbbbbb", kind: "preference", text: "Old one.", at: "2026-11-09T09:00:00.000Z", evidence: [{ at: "2026-11-09T09:00:00.000Z", by: "agent", note: "n", where: "deleted" }] },
		],
		subjects: [{
			name: "Economics",
			memories: [{ id: "m_cccccc", kind: "preference", text: "Aiming for a 7.", at: "2026-11-10T09:00:00.000Z", evidence: [{ at: "2026-11-10T09:00:00.000Z", by: "learner", note: "Added by you in Settings", where: "settings" }, { at: "2026-11-10T10:00:00.000Z", by: "learner", note: "Edited by you in Settings", where: "settings" }] }],
			areas: [{ name: "Unit 4", description: "Macro", memories: [] }],
		}],
	};

	it("renders the switch, the cap count, the tree and the three evidence states", () => {
		const html = renderToStaticMarkup(<ServerEventsProvider><MemorySection enabled onEnabledChange={() => {}} initialView={view} initialRow="m_aaaaaa" /></ServerEventsProvider>);
		assert.match(html, /role="switch" aria-checked="true"/);
		assert.match(html, /Profile \(2 \/ 15\)/);
		assert.match(html, /Economics/);
		assert.match(html, /Unit 4/);
		assert.match(html, /href="\/chat\/chat_1#message-toolu_1">Waves<\/a>/);
		assert.match(html, /from a deleted session/);
		assert.match(html, /Added by you in Settings/);
		assert.match(html, /Edited by you in Settings/);
		assert.match(html, /<details open="" class="group\/m" data-testid="memory-m_aaaaaa">/);
	});

	it("shows the store error instead of the tree", () => {
		const html = renderToStaticMarkup(<ServerEventsProvider><MemorySection enabled={false} onEnabledChange={() => {}} initialView={{ ...view, error: "Memory file is corrupt" }} /></ServerEventsProvider>);
		assert.match(html, /Memory file is corrupt/);
		assert.doesNotMatch(html, /Profile \(/);
	});
});
