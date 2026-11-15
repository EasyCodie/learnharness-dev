/**
 * View-reader bridges get `changed` assigned during render. React's dev
 * server renderer seals the object useRef returns, so a bridge held in a ref
 * threw "Cannot add property changed, object is not extensible" on every
 * directly loaded chat page in development (2026-11-13).
 */
import React, { useRef } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { useViewReader, type ViewReaderRef } from "../components/session-view-readers.ts";

test("a view reader accepts its change notifier during a server render", () => {
	function Page() {
		const reader = useViewReader<string>();
		reader.changed = () => {};
		return <i>{typeof reader.changed}{String(reader.current)}</i>;
	}
	assert.match(renderToString(<Page />), /function.*null/);
});

test("control: the same assignment on a useRef object is what threw", () => {
	function Page() {
		const reader = useRef<(() => string) | null>(null) as ViewReaderRef<string>;
		reader.changed = () => {};
		return null;
	}
	assert.throws(() => renderToString(<Page />), /object is not extensible/);
});
