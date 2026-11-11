// Settings → Memory: clicking an evidence link closes Settings (plan Default 80),
// and re-runs the jump when that message's hash is already in the URL.

import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemorySection } from "../components/settings/memory-section.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import type { MemoryView } from "../src/core/contracts/memory.ts";

const dom = parseHTML("<html><body></body></html>");
let hashEvents = 0;
const location = { pathname: "/chat/chat_1", hash: "" };
// linkedom's window has no location; stand in for it and count the re-fired hashchange.
const dispatchEvent = (e: Event) => { if (e.type === "hashchange") hashEvents++; return true; };
const win = new Proxy(dom.window, { get: (t, k) => (k === "location" ? location : k === "dispatchEvent" ? dispatchEvent : Reflect.get(t, k)) });
Object.assign(globalThis, { window: win, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true,
	// The events provider opens a channel on mount; an inert one is enough here.
	EventSource: class { addEventListener() {} close() {} } });

const view: MemoryView = {
	enabled: true, profileCap: 15, subjects: [],
	profile: [{ id: "m_aaaaaa", kind: "preference", text: "Prefers diagrams.", at: "2026-11-10T09:00:00.000Z", status: "active",
		evidence: [{ at: "2026-11-10T09:00:00.000Z", by: "agent", note: "n", stance: "confirm", where: { chatId: "chat_1", chatTitle: "Waves", anchor: "toolu_1" } }] }],
};

test("an evidence link click closes Settings; the same hash re-fires the jump", async () => {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	let closed = 0;
	await act(async () => root.render(<ServerEventsProvider><MemorySection enabled onEnabledChange={() => {}} initialView={view} onEvidenceOpen={() => closed++} /></ServerEventsProvider>));
	const link = document.querySelector<HTMLAnchorElement>('[data-testid="memory-evidence"] a')!;
	await act(async () => link.click());
	assert.equal(closed, 1);
	assert.equal(hashEvents, 0, "a new hash: the browser fires hashchange itself");
	location.hash = link.getAttribute("href")!.slice(location.pathname.length);
	await act(async () => link.click());
	assert.equal(closed, 2);
	assert.equal(hashEvents, 1, "the hash is already there: the jump is re-run");
	await act(async () => root.unmount());
});
