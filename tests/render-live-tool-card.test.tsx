/**
 * The LIVE tool-input card (owner, streaming round 2026-10-01): what a
 * tool call looks like while the agent writes it — Braille spinner +
 * shimmered activity label in the header (the retired bottom line's
 * text, one glimmer recipe), the streaming input watchable on expand.
 * These pins hold the working-state grammar on the card.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveToolCard } from "../components/artifacts/live-tool-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";

function part(tool: string, input: unknown) {
	return { type: `tool-${tool}`, toolCallId: "c1", state: "input-streaming", input };
}

describe("LiveToolCard (the working-state grammar)", () => {
	it("spinner + shimmered activity label + headline arg, input on expand", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("read", { path: "notes.md" }) as never} />);
		assert.match(html, /data-testid="live-tool-card"/);
		assert.match(html, /data-testid="braille-spinner"/);
		// the label names the ACTUAL tool (the old bottom line's text)
		assert.match(html, /Reading a file…/);
		// the headline argument rides the header
		assert.match(html, /notes\.md/);
		// the streaming input is shown in the expandable body
		assert.match(html, /Input \(streaming\)/);
		assert.match(html, /notes\.md/);
	});

	it("unknown tools stay generic; jobs get their dispatch labels", () => {
		assert.match(renderToStaticMarkup(<LiveToolCard part={part("mystery_tool", {}) as never} />), /Working…/);
		assert.match(
			renderToStaticMarkup(<LiveToolCard part={part("research", { query: "x" }) as never} />),
			/Dispatching research…/,
		);
	});

	it("no input yet renders a placeholder, not an empty pre", () => {
		const html = renderToStaticMarkup(<LiveToolCard part={part("grep", undefined) as never} />);
		assert.match(html, /<pre[^>]*>…<\/pre>/);
	});

	it("compute never renders its code, result or traceback, running or settled", () => {
		const SECRET = "ANSWER_KEY_42";
		const running = renderToStaticMarkup(<LiveToolCard part={part("compute", { code: `print(${SECRET})`, path: SECRET }) as never} />);
		assert.match(running, /Checking a calculation…/);
		assert.ok(!running.includes(SECRET), "running card leaks the code");
		const Card = artifactRenderers.compute!;
		for (const state of ["output-available", "output-error"]) {
			const settled = { type: "tool-compute", toolCallId: "c1", state, input: { code: SECRET }, rawInput: { code: SECRET }, output: SECRET, errorText: SECRET };
			const html = renderToStaticMarkup(<Card part={settled as never} />);
			assert.match(html, /Checked a calculation/);
			assert.ok(!html.includes(SECRET), `${state} card leaks`);
		}
	});
});
