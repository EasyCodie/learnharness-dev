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
				id: "m_aaaaaa", kind: "preference", text: "Wants a diagram before any algebra.", at: "2026-11-10T09:00:00.000Z", status: "active",
				evidence: [{ at: "2026-11-10T09:00:00.000Z", by: "agent", note: "He asked for pictures.", stance: "confirm", where: { chatId: "chat_1", chatTitle: "Waves", anchor: "toolu_1" } }],
			},
			{ id: "m_bbbbbb", kind: "preference", text: "Old one.", at: "2026-11-09T09:00:00.000Z", status: "active", evidence: [{ at: "2026-11-09T09:00:00.000Z", by: "agent", note: "n", stance: "confirm", where: "deleted" }] },
		],
		subjects: [{
			name: "Economics",
			memories: [{ id: "m_cccccc", kind: "preference", text: "Aiming for a 7.", at: "2026-11-10T09:00:00.000Z", status: "active", evidence: [{ at: "2026-11-10T09:00:00.000Z", by: "learner", note: "Added by you in Settings", stance: "confirm", where: "settings" }, { at: "2026-11-10T10:00:00.000Z", by: "learner", note: "Edited by you in Settings", stance: "confirm", where: "settings" }] }],
			areas: [{ name: "Unit 4", description: "Macro", memories: [] }],
		}],
	};
	const live = { chatId: "chat_2", chatTitle: "Projectiles", anchor: "q_1" };
	const phase2: MemoryView = {
		enabled: true,
		profileCap: 15,
		profile: [{
			id: "m_promot", kind: "mistake", text: "Drops minus signs when rearranging.", at: "2026-11-11T09:00:00.000Z", status: "active",
			evidence: [
				{ at: "2026-11-10T09:00:00.000Z", by: "curator", note: "sign lost", stance: "confirm", subject: "Physics", where: live },
				{ at: "2026-11-11T09:00:00.000Z", by: "curator", note: "again", stance: "confirm", subject: "Maths", promotedFrom: { subject: "Physics", area: "Kinematics" }, where: live },
			],
		}],
		subjects: [{
			name: "Physics",
			memories: [],
			areas: [{
				name: "Kinematics",
				description: "Motion",
				memories: [
					{ id: "m_flawed", kind: "thinking", flawed: true, text: "Treats rest as zero acceleration.", at: "2026-11-11T09:00:00.000Z", status: "unconfirmed", progress: { questions: 3, sessions: 1 },
						evidence: [{ at: "2026-11-11T09:00:00.000Z", by: "curator", note: "said a = 0", stance: "confirm", subject: "Physics", quote: "the acceleration is zero at the top", where: live }] },
					{ id: "m_fading", kind: "mistake", text: "Forgets units.", at: "2026-11-11T09:00:00.000Z", status: "fading",
						evidence: [{ at: "2026-11-11T09:00:00.000Z", by: "curator", note: "units right this time", stance: "contradict", subject: "Physics", where: live }] },
					{ id: "m_knowl1", kind: "knowledge", text: "Holds projectile range.", at: "2026-11-11T09:00:00.000Z", status: "active", propositions: [{ id: "n_1", name: "Range formula" }], evidence: [] },
					{ id: "m_note01", kind: "mistake", text: "Mixes sin and cos.", at: "2026-11-11T09:00:00.000Z", status: "note", evidence: [] },
					{ id: "m_sound1", kind: "thinking", flawed: false, text: "Reasons from net force.", at: "2026-11-11T09:00:00.000Z", status: "active", evidence: [] },
				],
			}],
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

	it("Phase 2: statuses, the Seen once group, sightings with subject, stance, quotes and the promotion line, the mark, linked propositions", () => {
		const html = renderToStaticMarkup(<ServerEventsProvider><MemorySection enabled onEnabledChange={() => {}} initialView={phase2} /></ServerEventsProvider>);
		assert.match(html, /Moved to Profile from Physics › Kinematics/);
		assert.match(html, /in Maths/);
		assert.match(html, /Unconfirmed \(3 of 3 questions, 1 of 2 sessions\)/);
		assert.match(html, /“the acceleration is zero at the top”/);
		assert.match(html, /Fading/);
		assert.match(html, /contradicts/);
		assert.match(html, /Linked: Range formula/);
		assert.match(html, /data-testid="memory-seen-once-Kinematics"[\s\S]*Mixes sin and cos/);
		assert.match(html, /aria-label="Sound or flawed"/);
		assert.match(html, />Flawed</);
		assert.match(html, />Sound</);
		// Kinematics counts its loaded memories, not its notes.
		assert.match(html, /Kinematics <span class="text-muted-foreground">\(4\)<\/span>/);
	});

	it("shows the store error instead of the tree", () => {
		const html = renderToStaticMarkup(<ServerEventsProvider><MemorySection enabled={false} onEnabledChange={() => {}} initialView={{ ...view, error: "Memory file is corrupt" }} /></ServerEventsProvider>);
		assert.match(html, /Memory file is corrupt/);
		assert.doesNotMatch(html, /Profile \(/);
	});
});
