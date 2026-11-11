import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { PathInput, INSERT_CITATION_EVENT, INSERT_FILE_PATHS_EVENT, MATH_STATE_EVENT, TOGGLE_MATH_EVENT, UPDATE_CITATION_EVENT } from "../components/path-input.tsx";
import {
	PATH_CARET_ATTRIBUTE, PATH_SOURCE_ATTRIBUTE, PathInputHistory, adjacentPathRange, atomicPathRange,
	insertCitation, insertFilePaths, normalizePathEdit, normalizePathInputValue, pathInputOffset, pathInputPoint, pathInputStaticRange, readPathInput,
	readPathSelection, renderPathInput, replacePathSelection, restorePathSelection,
} from "../components/path-input-dom.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";
import { closeKeyboard, editableLatex, isMathToggle, openKeyboard, scriptTarget, storableLatex } from "../components/math-chip.tsx";

/** Stands in for MathLive's field, which cannot mount under linkedom. It never fires `mount` by itself. */
function FakeField() {
	if (FakeField.fail) throw new Error("MathLive load failed");
	const field: any = document.createElement("span");
	return Object.assign(field, {
		value: "", selection: null, placeholderSymbol: "", position: 0, lastOffset: 0,
		getValue: (format?: string) => (format === "latex-expanded" ? field.value : ""),
		hasFocus: () => document.activeElement === field,
		executeCommand: ([, text]: [string, string]) => { field.value += text; },
	});
}
FakeField.fail = false;
FakeField.fontsDirectory = null as string | null;
FakeField.soundsDirectory = null as string | null;
// Faked only from the first test that needs a working field: the tests before it rely on the
// real MathLive failing to load under linkedom.
let faked: unknown;
const fakeMathLive = () => { faked ??= mock.module("mathlive", { namedExports: { MathfieldElement: FakeField } }); };
import { serializeCitation } from "../src/core/citations.ts";

function editor() {
	const { document } = parseHTML("<html><body><div id='editor'></div></body></html>");
	return document.getElementById("editor")!;
}

test("DOM projection is lossless across whitespace, Unicode and all rooted path forms", () => {
	const root = editor();
	const paths = ["/a/notes one.pdf", "C:\\a\\notes.pdf", "\\\\host\\share\\sheet.csv", "~/notes`final`.pdf"];
	const value = `  👩🏽‍💻\t中\n${paths.map(quoteFilePath).join("\n\t")}\n \n`;
	const hosts = renderPathInput(root, value);
	assert.equal(hosts.length, paths.length);
	for (const { host } of hosts) {
		host.textContent = "abbreviated.pdf";
		assert.equal(host.getAttribute("contenteditable"), "false");
	}
	assert.equal(readPathInput(root), value);
	assert.equal(root.dataset.empty, "false");
	renderPathInput(root, "");
	assert.equal(readPathInput(root), "");
	assert.equal(root.dataset.empty, "true");
});

test("logical offsets round-trip across text, adjacent chips, line breaks and reversed selections", () => {
	const root = editor();
	const value = `🙂A ${quoteFilePath("/one")} ${quoteFilePath("/two")}\nend`;
	renderPathInput(root, value);
	for (let offset = 0; offset <= value.length; offset++) {
		const point = pathInputPoint(root, offset);
		const mapped = pathInputOffset(root, point.node, point.offset)!;
		const token = Array.from(root.querySelectorAll(`[${PATH_SOURCE_ATTRIBUTE}]`)).find((host) => {
			const start = value.indexOf(host.getAttribute(PATH_SOURCE_ATTRIBUTE)!);
			return offset > start && offset < start + host.getAttribute(PATH_SOURCE_ATTRIBUTE)!.length;
		});
		if (!token) assert.equal(mapped, offset, `offset ${offset}`);
		else {
			const raw = token.getAttribute(PATH_SOURCE_ATTRIBUTE)!;
			const start = value.indexOf(raw);
			assert.ok(mapped === start || mapped === start + raw.length);
		}
	}
	assert.equal(pathInputOffset(root, root.ownerDocument.body, 0), null);
});

test("BR/block fallback never reads visual labels or normalizes ordinary spaces", () => {
	const root = editor();
	root.innerHTML = "<div> a  </div><div><br></div><div>b</div>";
	assert.equal(readPathInput(root), " a  \n\nb");
	root.innerHTML = "<br>";
	assert.equal(readPathInput(root), "");
	root.innerHTML = "a<br>b";
	assert.equal(readPathInput(root), "a\nb");
});

test("trailing newline caret placeholder is presentation-only and logical end maps before it", () => {
	const root = editor();
	for (const value of ["\n", "\n\n", "one\n", "one\n\n", "one\n\n\n"]) {
		renderPathInput(root, value);
		assert.equal(root.querySelectorAll(`[${PATH_CARET_ATTRIBUTE}]`).length, 1);
		assert.equal(root.lastElementChild?.tagName, "BR");
		assert.equal(root.lastElementChild?.getAttribute("aria-hidden"), "true");
		assert.equal(root.textContent, value);
		assert.equal(readPathInput(root), value);
		const point = pathInputPoint(root, value.length);
		assert.equal(point.node, root);
		assert.equal(point.offset, root.childNodes.length - 1);
		assert.equal(pathInputOffset(root, point.node, point.offset), value.length);
		assert.equal(pathInputOffset(root, root.lastChild!, 0), value.length);
	}
	for (const value of ["", "one", "one\ntwo"]) {
		renderPathInput(root, value);
		assert.equal(root.querySelector(`[${PATH_CARET_ATTRIBUTE}]`), null);
		assert.equal(readPathInput(root), value);
	}
});

test("range replacement/deletion is atomic and leaves neighboring whitespace untouched", () => {
	const token = quoteFilePath("/course/notes.pdf");
	const value = `a ${token} b`;
	assert.deepEqual(atomicPathRange(value, { anchor: 5, focus: 1 }), { start: 1, end: 2 + token.length });
	assert.equal(replacePathSelection(value, { anchor: 3, focus: 8 }, "").value, "a  b");
	assert.deepEqual(adjacentPathRange(value, { anchor: 2, focus: 2 }, "forward"), { anchor: 2, focus: 2 + token.length });
	assert.deepEqual(adjacentPathRange(value, { anchor: 2 + token.length, focus: 2 + token.length }, "backward"), { anchor: 2, focus: 2 + token.length });
	assert.equal(adjacentPathRange(value, { anchor: 1, focus: 1 }, "forward"), null);
});

test("file insertion uses full quoted sources at saved ranges with separating spaces", () => {
	const next = insertFilePaths("readthis", { anchor: 4, focus: 4 }, ["/a b.pdf", "C:\\a\\x.txt"]);
	assert.equal(next.value, "read `/a b.pdf` `C:\\a\\x.txt` this");
	assert.equal(next.selection.anchor, next.value.length - 4);
	assert.equal(insertFilePaths("a\n", { anchor: 2, focus: 2 }, ["~/x"]).value, "a\n`~/x`");
	assert.throws(() => insertFilePaths("", { anchor: 0, focus: 0 }, ["relative.txt"]), TypeError);
});

test("owned history restores values and directional selections; a new edit discards redo", () => {
	const history = new PathInputHistory();
	const a = { value: "a", selection: { anchor: 1, focus: 0 } };
	const b = { value: "ab", selection: { anchor: 2, focus: 2 } };
	history.push(a);
	assert.deepEqual(history.undo(b), a);
	assert.deepEqual(history.redo(a), b);
	history.undo(b);
	history.push(a);
	assert.equal(history.redo(b), null);
	history.reset();
	assert.equal(history.undo(b), null);
});

test("textbox exposes accessibility, placeholder, global-drop markers and requested sizing", () => {
	const html = renderToStaticMarkup(<PathInput value="" onValueChange={() => {}} placeholder="Ask" aria-label="Message" defaultDropTarget className="min-h-24 max-h-64" />);
	for (const pattern of [/role="textbox"/, /aria-multiline="true"/, /aria-label="Message"/, /data-file-path-input=""/, /data-file-path-default=""/, /data-placeholder="Ask"/, /min-h-24 max-h-64/]) assert.match(html, pattern);
});

test("SSR preserves the full escaped initial draft without waiting for client effects", () => {
	const draft = "  Restored <reasoning> & notes\n`/course/full notes.pdf`\n ";
	const html = renderToStaticMarkup(<PathInput value={draft} onValueChange={() => assert.fail("SSR cannot emit changes")} placeholder="Reasoning" />);
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	const field = document.querySelector('[data-file-path-input]')!;
	assert.equal(field.textContent, draft);
	assert.equal(field.getAttribute("contenteditable") ?? field.getAttribute("contentEditable"), "true");
	assert.equal(field.getAttribute("data-empty"), "false");
	assert.equal(field.querySelector("reasoning"), null);
	assert.match(html, /&lt;reasoning&gt;/);
	const single = renderToStaticMarkup(<PathInput singleLine value={"one\r\ntwo"} onValueChange={() => {}} />);
	assert.equal(parseHTML(`<html><body>${single}</body></html>`).document.body.textContent, "onetwo");
});

test("textbox accessible name falls back to placeholder and preserves explicit aria-label", () => {
	const fallback = renderToStaticMarkup(<PathInput value="" onValueChange={() => {}} placeholder="Your reasoning" />);
	assert.match(fallback, /aria-label="Your reasoning"/);
	const explicit = renderToStaticMarkup(<PathInput value="" onValueChange={() => {}} placeholder="Your reasoning" aria-label="Custom answer" />);
	assert.match(explicit, /aria-label="Custom answer"/);
	assert.doesNotMatch(explicit, /aria-label="Your reasoning"/);
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

/** linkedom has no Selection/default editing actions. The shim tests our offset
 * contract, NOT browser caret navigation or the native IME implementation. */
async function fixture(initial: string, singleLine = false) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div><button id='elsewhere'></button></body></html>");
	let active: Element = doc.body;
	// Like a browser: focus falls back to the body when the focused element is removed.
	Object.defineProperty(doc, "activeElement", { get: () => active.isConnected ? active : doc.body });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	Object.assign(win, { mathVirtualKeyboard: { layouts: [], boundingRect: { height: 0 }, addEventListener() {}, show() {}, hide() {} } });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ React, window: win, document: doc, HTMLElement: win.HTMLElement, Element: win.Element, Event: win.Event, CustomEvent: win.CustomEvent, requestAnimationFrame: (run: () => void) => run(), IS_REACT_ACT_ENVIRONMENT: true })) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const reactRoot = createRoot(doc.getElementById("root")!);
	const ref = React.createRef<HTMLDivElement>();
	let value = initial;
	const writes: string[] = [];
	let keys = 0;
	function draw() {
		reactRoot.render(<PathInput ref={ref} singleLine={singleLine} value={value} onValueChange={(next) => { writes.push(next); value = next; draw(); }} onKeyDown={() => { keys++; }} />);
	}
	await act(async () => { draw(); });
	cleanup = async () => {
		await act(async () => { reactRoot.unmount(); });
		// A folding math keyboard removes itself on a timer that still needs these globals.
		if (doc.querySelector(".lh-math-keyboard")) await new Promise((resolve) => setTimeout(resolve, 250));
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const root = ref.current!;
	root.focus();
	function select(anchor: number, focus = anchor) {
		restorePathSelection(root, { anchor, focus });
		doc.dispatchEvent(new win.Event("selectionchange"));
	}
	async function event(type: string, properties: Record<string, unknown> = {}) {
		const event = new win.Event(type, { bubbles: true, cancelable: true });
		Object.assign(event, properties);
		await act(async () => { root.dispatchEvent(event); });
		return event;
	}
	return {
		root, doc, select, event, writes, selection,
		get value() { return value; }, get keys() { return keys; },
		async external(next: string) { await act(async () => { value = next; draw(); }); },
		async nativeText(next: string, inputType = "insertText") {
			await event("beforeinput", { inputType, isComposing: false });
			root.replaceChildren(doc.createTextNode(next));
			select(next.length);
			await event("input", { inputType });
		},
	};
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function openField(f: { root: HTMLElement; doc: Document }) {
	await settle();
	const field = f.root.querySelector(".lh-math-field > *") as HTMLElement;
	if (!field) throw new Error("expected field under .lh-math-field");
	await act(async () => {
		field.dispatchEvent(new f.doc.defaultView!.Event("mount"));
	});
	return field;
}

async function edit(field: HTMLElement, latex: string) {
	(field as any).value = latex;
	await act(async () => {
		field.dispatchEvent(new field.ownerDocument.defaultView!.Event("input", { bubbles: true }));
	});
}

test("native typing, token insertion/deletion and undo/redo share one history", async () => {
	const f = await fixture("a");
	f.select(1);
	await f.nativeText("ab");
	await f.event(INSERT_FILE_PATHS_EVENT, { detail: ["/notes.pdf"] });
	assert.equal(f.value, "ab `/notes.pdf`");
	assert.match(f.root.textContent!, /notes.pdf/);
	await f.event("keydown", { key: "Backspace" });
	assert.equal(f.value, "ab ");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "ab `/notes.pdf`");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "ab");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "a");
	await f.event("beforeinput", { inputType: "historyRedo" });
	assert.equal(f.value, "ab");
});

test("Cmd+Backspace delegates line extent to beforeinput instead of deleting just the final chip", async () => {
	const source = "Explain `/tmp/notes.pdf`";
	const f = await fixture(source);
	f.select(source.length);
	const key = await f.event("keydown", { key: "Backspace", metaKey: true });
	assert.equal(key.defaultPrevented, false);
	assert.equal(f.value, source);
	const deletion = await f.event("beforeinput", {
		inputType: "deleteSoftLineBackward",
		getTargetRanges: () => [{ startContainer: f.root.firstChild!, startOffset: 0, endContainer: f.root, endOffset: f.root.childNodes.length }],
	});
	assert.equal(deletion.defaultPrevented, true);
	assert.equal(f.value, "");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, source);
	assert.deepEqual(readPathSelection(f.root), { anchor: source.length, focus: source.length });
});

test("native word and soft/hard line deletion ranges retain mixed text/chip extents in both directions", async () => {
	const source = "keep old `/tmp/notes.pdf` tail\nnext";
	const f = await fixture(source);
	const lineEnd = source.indexOf("\n");
	const chipEnd = source.indexOf(" tail");
	const cases = [
		["deleteWordBackward", 5, lineEnd], ["deleteWordForward", 5, chipEnd],
		["deleteSoftLineBackward", 0, lineEnd], ["deleteSoftLineForward", 5, lineEnd],
		["deleteHardLineBackward", 0, chipEnd], ["deleteHardLineForward", 5, lineEnd],
	] as const;
	for (const [inputType, start, end] of cases) {
		await f.external(source);
		const backward = inputType.endsWith("Backward");
		f.select(backward ? end : start);
		const key = await f.event("keydown", { key: backward ? "Backspace" : "Delete", ctrlKey: true });
		assert.equal(key.defaultPrevented, false, inputType);
		assert.equal(f.value, source);
		const a = pathInputPoint(f.root, start);
		const b = pathInputPoint(f.root, end);
		const deletion = await f.event("beforeinput", {
			inputType,
			getTargetRanges: () => [{ startContainer: a.node, startOffset: a.offset, endContainer: b.node, endOffset: b.offset }],
		});
		assert.equal(deletion.defaultPrevented, true, inputType);
		assert.equal(f.value, source.slice(0, start) + source.slice(end), inputType);
		assert.deepEqual(readPathSelection(f.root), { anchor: start, focus: start });
	}
});

test("deleteEntireSoftLine honors the browser extent and never substitutes a chip when ranges are absent", async () => {
	const source = "before\nExplain `/tmp/notes.pdf` tail\nafter";
	const f = await fixture(source);
	const start = source.indexOf("Explain");
	const end = source.indexOf("\nafter");
	f.select(source.indexOf("`")); // Adjacent to a chip, but not a chip-only command.
	for (const getTargetRanges of [undefined, () => []]) {
		const missing = await f.event("beforeinput", { inputType: "deleteEntireSoftLine", getTargetRanges });
		assert.equal(missing.defaultPrevented, false);
		assert.equal(f.value, source);
	}
	const a = pathInputPoint(f.root, start);
	const b = pathInputPoint(f.root, end);
	const deletion = await f.event("beforeinput", {
		inputType: "deleteEntireSoftLine",
		getTargetRanges: () => [{ startContainer: a.node, startOffset: a.offset, endContainer: b.node, endOffset: b.offset }],
	});
	assert.equal(deletion.defaultPrevented, true);
	assert.equal(f.value, "before\n\nafter");
	assert.deepEqual(readPathSelection(f.root), { anchor: start, focus: start });
});

test("browser target ranges that intersect a visual chip interior expand the complete source atomically", async () => {
	const source = "keep old `/tmp/notes.pdf` tail";
	const f = await fixture(source);
	f.select(5);
	const label = f.root.querySelector(`[${PATH_SOURCE_ATTRIBUTE}] [role=img] span`)!.firstChild!;
	const start = pathInputPoint(f.root, 5);
	const target = { startContainer: start.node, startOffset: start.offset, endContainer: label, endOffset: 2 };
	const mapped = pathInputStaticRange(f.root, target)!;
	assert.ok(mapped.focus > source.indexOf("`"));
	assert.ok(mapped.focus < source.lastIndexOf("`") + 1);
	await f.event("beforeinput", { inputType: "deleteWordForward", getTargetRanges: () => [target] });
	assert.equal(f.value, "keep  tail");
	assert.equal(f.root.querySelector(`[${PATH_SOURCE_ATTRIBUTE}]`), null);
});

test("missing or invalid word/line target ranges defer to native editing and preserve owned undo", async () => {
	const source = "Explain `/tmp/notes.pdf`";
	const f = await fixture(source);
	f.select(source.length);
	for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
		for (const key of ["Backspace", "Delete"]) {
			const event = await f.event("keydown", { key, [modifier]: true });
			assert.equal(event.defaultPrevented, false);
			assert.equal(f.value, source);
		}
	}
	for (const inputType of ["deleteWordBackward", "deleteWordForward", "deleteSoftLineBackward", "deleteSoftLineForward", "deleteHardLineBackward", "deleteHardLineForward"]) {
		for (const getTargetRanges of [undefined, () => []]) {
			const beforeInput = await f.event("beforeinput", { inputType, getTargetRanges });
			assert.equal(beforeInput.defaultPrevented, false, `${inputType} must not fall through to adjacent-chip deletion`);
			assert.equal(f.value, source);
		}
	}
	const valid = { startContainer: f.root, startOffset: 0, endContainer: f.root, endOffset: f.root.childNodes.length };
	for (const getTargetRanges of [
		undefined, () => [], () => [{ ...valid, startContainer: f.doc.body }],
		() => [{ ...valid, startOffset: -1 }], () => [{ ...valid, endOffset: 999 }],
		() => [{ ...valid, endOffset: 0 }], () => [valid, valid], () => { throw new Error("not available"); },
	]) {
		const beforeInput = await f.event("beforeinput", { inputType: "deleteWordBackward", getTargetRanges });
		assert.equal(beforeInput.defaultPrevented, false);
		assert.equal(f.value, source);
	}
	// With no usable target ranges the browser edits the DOM, then input projects it.
	await f.nativeText("", "deleteHardLineBackward");
	assert.equal(f.value, "");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, source);
});

test("ordinary backward/forward chip deletion and selected ranges retain their existing behavior", async () => {
	const source = "a `/tmp/notes.pdf` b";
	const f = await fixture(source);
	f.select(source.length - 2);
	const backspace = await f.event("keydown", { key: "Backspace" });
	assert.equal(backspace.defaultPrevented, true);
	assert.equal(f.value, "a  b");
	await f.external(source);
	f.select(2);
	const forward = await f.event("keydown", { key: "Delete" });
	assert.equal(forward.defaultPrevented, true);
	assert.equal(f.value, "a  b");
	await f.external(source);
	f.select(source.length, 0);
	const selected = await f.event("keydown", { key: "Backspace" });
	assert.equal(selected.defaultPrevented, true);
	assert.equal(f.value, "");
});

test("immutable SSR fallback never stomps native edits, controlled updates, chips or reset", async () => {
	const initial = "Restored draft `/course/original.pdf`";
	const f = await fixture(initial);
	assert.equal(readPathInput(f.root), initial);
	assert.equal(f.root.querySelectorAll(`[${PATH_SOURCE_ATTRIBUTE}]`).length, 1);
	f.select(initial.length);
	await f.nativeText("New typed draft");
	assert.equal(readPathInput(f.root), "New typed draft");
	assert.equal(f.root.textContent, "New typed draft");
	await f.external("Controlled `/course/replaced.pdf`");
	assert.equal(readPathInput(f.root), "Controlled `/course/replaced.pdf`");
	assert.equal(f.root.querySelectorAll(`[${PATH_SOURCE_ATTRIBUTE}]`).length, 1);
	assert.doesNotMatch(f.root.textContent!, /Restored draft/);
	await f.external("");
	await f.external(""); // Re-render again with the same initial fallback child prop.
	assert.equal(readPathInput(f.root), "");
	assert.equal(f.root.textContent, "");
	assert.equal(f.root.dataset.empty, "true");
});

test("external dictation append/reset and drop at an unfocused saved selection", async () => {
	const f = await fixture("one two");
	f.select(3);
	f.doc.getElementById("elsewhere")!.focus();
	await f.event(INSERT_FILE_PATHS_EVENT, { detail: ["/notes one.pdf"] });
	assert.equal(f.value, "one `/notes one.pdf` two");
	assert.equal(f.doc.activeElement, f.root);
	assert.equal(f.keys, 0, "staging must not submit");
	f.select(f.value.length);
	await f.external(`${f.value}\nspoken words`);
	assert.equal(readPathInput(f.root), f.value);
	await f.event("keydown", { key: "z", ctrlKey: true });
	assert.equal(f.value, "one `/notes one.pdf` two");
	await f.external("");
	assert.equal(readPathInput(f.root), "");
	await f.event("keydown", { key: "z", ctrlKey: true });
	assert.equal(f.value, "");
});

test("plaintext paste ignores HTML and copy/cut use full token source in either direction", async () => {
	const source = "read `/deep/course/notes.pdf` now";
	const f = await fixture(source);
	f.select(source.length - 4, 5);
	const clipboard = new Map<string, string>();
	const clipboardData = { setData: (type: string, text: string) => clipboard.set(type, text), getData: (type: string) => type === "text/plain" ? "<img src=x onerror=alert(1)>\n中" : "<b>unsafe HTML</b>" };
	await f.event("copy", { clipboardData });
	assert.equal(clipboard.get("text/plain"), "`/deep/course/notes.pdf`");
	await f.event("cut", { clipboardData });
	assert.equal(f.value, "read  now");
	f.select(5);
	await f.event("paste", { clipboardData });
	assert.equal(f.value, "read <img src=x onerror=alert(1)>\n中 now");
	assert.equal(f.root.querySelector("img"), null);
	assert.equal(readPathInput(f.root), f.value);
});

test("image/file-only paste prevents native insertion without deleting selected text or chips", async () => {
	const source = "plain `/course/notes.pdf` end";
	const f = await fixture(source);
	const clipboardData = { types: ["Files", "image/png"], getData: () => "" };
	for (const [anchor, focus] of [[0, 5], [6, source.length - 4]]) {
		f.select(anchor!, focus!);
		const paste = await f.event("paste", { clipboardData });
		assert.equal(paste.defaultPrevented, true);
		assert.equal(f.value, source);
		assert.equal(readPathInput(f.root), source);
	}
	assert.deepEqual(f.writes, []);
	assert.equal(f.root.querySelectorAll(`[${PATH_SOURCE_ATTRIBUTE}]`).length, 1);
});

test("empty clipboard text stays a no-op before, during and after IME with a chip selected", async () => {
	const source = "a `/course/notes.pdf` z";
	const f = await fixture(source);
	f.select(2, source.length - 2);
	const clipboardData = { getData: () => "", types: ["text/html"] };
	await f.event("paste", { clipboardData });
	await f.event("compositionstart");
	const during = await f.event("paste", { clipboardData });
	assert.equal(during.defaultPrevented, true);
	assert.equal(readPathInput(f.root), source);
	await f.event("compositionend");
	assert.equal(readPathInput(f.root), source, "no empty pending paste can remove the selected chip");
	await f.event("paste", { clipboardData });
	assert.equal(f.value, source);
	assert.deepEqual(f.writes, []);
});

test("Shift+Delete delegates to cut, preserving full-source clipboard and deleting only once", async () => {
	const f = await fixture("plain`/next.pdf`");
	for (const [source, selected] of [["plain`/next.pdf`", "plain"], ["`/course/notes.pdf` `/next.pdf`", "`/course/notes.pdf` "]] as const) {
		await f.external(source);
		f.select(0, selected.length);
		const key = await f.event("keydown", { key: "Delete", shiftKey: true });
		assert.equal(key.defaultPrevented, false, "native Cut shortcut must reach the browser");
		assert.equal(f.value, source, "keydown alone must not delete the selection");
		let copied = "";
		const cut = await f.event("cut", { clipboardData: { setData: (type: string, value: string) => { assert.equal(type, "text/plain"); copied = value; } } });
		assert.equal(cut.defaultPrevented, true);
		assert.equal(copied, selected);
		assert.equal(f.value, "`/next.pdf`");
		const beforeInput = await f.event("beforeinput", { inputType: "deleteByCut" });
		assert.equal(beforeInput.defaultPrevented, true);
		assert.equal(f.value, "`/next.pdf`", "a trailing deleteByCut must not delete the neighboring chip");
	}
});

test("copying even a partial visual chip label copies its complete source", async () => {
	const f = await fixture("read `/deep/course/notes.pdf` now");
	const label = f.root.querySelector(`[${PATH_SOURCE_ATTRIBUTE}] [role=img] span`)!.firstChild!;
	f.selection.setBaseAndExtent(label, 1, label, 3);
	f.doc.dispatchEvent(new window.Event("selectionchange"));
	let copied = "";
	await f.event("copy", { clipboardData: { setData: (_type: string, value: string) => { copied = value; } } });
	assert.equal(copied, "`/deep/course/notes.pdf`");
});

test("composition keeps native DOM untouched, emits once, and suppresses consumer Enter", async () => {
	const f = await fixture("hello ");
	f.select(6);
	await f.event("compositionstart");
	f.root.replaceChildren(f.doc.createTextNode("hello 中"));
	f.select(7);
	await f.event("input", { isComposing: true });
	await f.event("keydown", { key: "Enter", keyCode: 229, isComposing: true });
	assert.equal(f.writes.length, 0);
	assert.equal(f.keys, 0);
	assert.equal(readPathInput(f.root), "hello 中");
	await f.event("compositionend");
	assert.deepEqual(f.writes, ["hello 中"]);
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "hello ");
});

test("Enter inserts a literal newline and range deletion spans text and complete chips", async () => {
	const f = await fixture("a `/one.pdf` b");
	f.select(f.value.length);
	await f.event("beforeinput", { inputType: "insertParagraph" });
	assert.equal(f.value, "a `/one.pdf` b\n");
	f.select(1, f.value.length - 1);
	await f.event("keydown", { key: "Delete" });
	assert.equal(f.value, "a\n");
	assert.equal(readPathInput(f.root), "a\n");
});

test("multiple trailing newlines preserve selection and survive native Backspace plus undo/redo", async () => {
	const f = await fixture("one\n\n");
	f.select(f.value.length, 1);
	assert.deepEqual(readPathSelection(f.root), { anchor: 5, focus: 1 });
	f.select(f.value.length);
	assert.equal(f.selection.focusNode, f.root);
	assert.equal(f.root.lastElementChild?.hasAttribute(PATH_CARET_ATTRIBUTE), true);
	// linkedom has no default Backspace action; model the native text deletion.
	await f.nativeText("one\n", "deleteContentBackward");
	assert.equal(f.value, "one\n");
	assert.equal(readPathInput(f.root), f.value);
	assert.equal(f.root.querySelectorAll(`[${PATH_CARET_ATTRIBUTE}]`).length, 1);
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "one\n\n");
	assert.deepEqual(readPathSelection(f.root), { anchor: 5, focus: 5 });
	assert.equal(f.root.querySelectorAll(`[${PATH_CARET_ATTRIBUTE}]`).length, 1);
	await f.event("keydown", { key: "z", metaKey: true, shiftKey: true });
	assert.equal(f.value, "one\n");
	assert.deepEqual(readPathSelection(f.root), { anchor: 4, focus: 4 });
	await f.external("");
	assert.equal(f.root.dataset.empty, "true");
	assert.equal(f.root.querySelector(`[${PATH_CARET_ATTRIBUTE}]`), null);
});

test("single-line mode never adds a trailing newline caret placeholder", async () => {
	const f = await fixture("one\n\n", true);
	assert.equal(readPathInput(f.root), "one");
	assert.equal(f.root.querySelector(`[${PATH_CARET_ATTRIBUTE}]`), null);
});

test("paste during IME stays plaintext and is deferred until composition finishes", async () => {
	const f = await fixture("");
	f.select(0);
	await f.event("compositionstart");
	f.root.replaceChildren(f.doc.createTextNode("中"));
	f.select(1);
	await f.event("input", { isComposing: true });
	assert.equal(f.root.dataset.empty, "false", "placeholder hides without normalizing the composing DOM");
	const paste = await f.event("paste", { clipboardData: { getData: () => "<b>plain</b>" } });
	assert.equal(paste.defaultPrevented, true);
	assert.equal(readPathInput(f.root), "中");
	assert.equal(f.writes.length, 0);
	await f.event("compositionend");
	assert.equal(f.value, "中<b>plain</b>");
	assert.equal(f.root.querySelector("b"), null);
});

test("single-line normalization strips only CR/LF and remaps directional UTF-16 selections", () => {
	const source = "🙂\r\n中\t x\ny\r";
	assert.equal(normalizePathInputValue(source, false), source);
	assert.equal(normalizePathInputValue(source, true), "🙂中\t xy");
	assert.deepEqual(normalizePathEdit({ value: source, selection: { anchor: source.length, focus: 4 } }, true), {
		value: "🙂中\t xy", selection: { anchor: 7, focus: 2 },
	});
});

test("single-line mode exposes native input accessibility and horizontal, nonwrapping layout", () => {
	const html = renderToStaticMarkup(<PathInput value="" onValueChange={() => {}} singleLine className="h-8" />);
	assert.match(html, /aria-multiline="false"/);
	assert.match(html, /whitespace-pre /);
	assert.match(html, /overflow-x-auto/);
	assert.match(html, /overflow-y-hidden/);
	assert.doesNotMatch(html, /whitespace-pre-wrap/);
	assert.match(html, /h-8/);
});

test("single-line initial/external assignment sanitizes silently; native edits and paste emit sanitized values", async () => {
	const f = await fixture("one\r\ntwo\n", true);
	assert.equal(readPathInput(f.root), "onetwo");
	assert.deepEqual(f.writes, []);
	await f.external("hello\r\nworld");
	assert.equal(readPathInput(f.root), "helloworld");
	assert.deepEqual(f.writes, []);
	f.select(10);
	await f.nativeText("ab\r\nc");
	assert.equal(f.value, "abc");
	assert.equal(readPathInput(f.root), "abc");
	assert.equal(pathInputOffset(f.root, f.selection.focusNode!, f.selection.focusOffset), 3);
	await f.event("paste", { clipboardData: { getData: () => "x\r\n y\n" } });
	assert.equal(f.value, "abcx y");
	assert.deepEqual(f.writes, ["abc", "abcx y"]);
});

test("single-line Enter reaches its consumer but cannot insert a newline", async () => {
	const f = await fixture("answer", true);
	f.select(6);
	await f.event("keydown", { key: "Enter", shiftKey: true });
	assert.equal(f.keys, 1);
	const paragraph = await f.event("beforeinput", { inputType: "insertParagraph" });
	const lineBreak = await f.event("beforeinput", { inputType: "insertLineBreak" });
	assert.equal(paragraph.defaultPrevented, true);
	assert.equal(lineBreak.defaultPrevented, true);
	assert.equal(f.value, "answer");
	assert.deepEqual(f.writes, []);
	await f.event(INSERT_FILE_PATHS_EVENT, { detail: ["/course/notes.pdf"] });
	assert.equal(f.value, "answer `/course/notes.pdf`");
});

test("single-line IME sanitizes after completion, and queued external assignments do not synthesize changes", async () => {
	const f = await fixture("a", true);
	f.select(1);
	await f.event("compositionstart");
	f.root.replaceChildren(f.doc.createTextNode("a中\r\n文"));
	f.select(5);
	await f.event("input", { isComposing: true });
	assert.deepEqual(f.writes, []);
	await f.event("compositionend");
	assert.equal(f.value, "a中文");
	assert.equal(readPathInput(f.root), "a中文");
	await f.event("compositionstart");
	await f.external("external\r\nvalue");
	assert.equal(readPathInput(f.root), "a中文", "assignment waits for native composition to finish");
	await f.event("compositionend");
	assert.equal(readPathInput(f.root), "externalvalue");
	assert.deepEqual(f.writes, ["a中文"]);
});

test("\\(…\\) equations are atomic chips: lossless DOM, whole-token delete and selection", () => {
	const root = editor();
	const value = `so \\(\\frac12\\) costs $5 and $6 ${quoteFilePath("/a.pdf")}`;
	const hosts = renderPathInput(root, value);
	assert.deepEqual(hosts.map(({ token }) => token.kind === "math" ? token.latex : token.kind === "path" ? token.path : null), ["\\frac12", "/a.pdf"]);
	assert.equal(hosts[0]!.token.start, 3);
	for (const { host } of hosts) host.textContent = "rendered";
	assert.equal(readPathInput(root), value);
	const end = 3 + "\\(\\frac12\\)".length;
	assert.deepEqual(adjacentPathRange(value, { anchor: end, focus: end }, "backward"), { anchor: 3, focus: end });
	assert.deepEqual(atomicPathRange(value, { anchor: 5, focus: end + 2 }), { start: 3, end: end + 2 });
});

test("equations are stored without MathLive's empty-slot markers or empty limits", () => {
	// An integral left with empty limits is indefinite; KaTeX cannot render \\placeholder.
	// Input is MathLive's "latex-expanded" output, which keeps \\placeholder.
	assert.equal(storableLatex("\\int_{\\placeholder{}}^{\\placeholder{}}\\sqrt{3-\\sin^2x}\\mathrm{d}x"), "\\int\\sqrt{3-\\sin^2x}\\mathrm{d}x");
	assert.equal(storableLatex("\\sum_{n=1}^{\\placeholder[up]{}}a_n"), "\\sum_{n=1}a_n");
	assert.equal(storableLatex("\\frac{\\placeholder{}}{2}"), "\\frac{}{2}");
	// Removing a slot must not glue a command to the letters after it (\\int + xdx ≠ \\intxdx).
	assert.equal(storableLatex("\\int_{\\placeholder{}}^{\\placeholder{}}xdx"), "\\int xdx");
	assert.equal(storableLatex("\\alpha\\placeholder{}x"), "\\alpha x");
	assert.equal(editableLatex(storableLatex("\\int_{\\placeholder{}}^{\\placeholder{}}xdx")), "\\int_{\\placeholder{}}^{\\placeholder{}} xdx");
	assert.equal(storableLatex("\\{\\}_\\{"), "\\{\\}_\\{");
});

test("reopened integrals, sums and products get their empty limit boxes back", () => {
	const empty = "_{\\placeholder{}}^{\\placeholder{}}";
	assert.equal(editableLatex("\\int\\sqrt{x}\\mathrm{d}x"), `\\int${empty}\\sqrt{x}\\mathrm{d}x`);
	assert.equal(editableLatex("\\sum a+\\prod b"), `\\sum${empty} a+\\prod${empty} b`);
	// Existing limits and longer commands are left alone.
	for (const latex of ["\\int_0^1x", "\\sum^{n}a", "\\intop x", "\\iint f"]) assert.equal(editableLatex(latex), latex);
	for (const latex of ["\\int\\sqrt{x}\\mathrm{d}x", "\\sum a+\\prod b"]) assert.equal(storableLatex(editableLatex(latex)), latex);
});

test("ArrowUp/Down cross between an atom's subscript and superscript, like the limits of an integral", () => {
	// Minimal stand-in for MathLive's atom tree: branches start with a "first" atom.
	type FakeAtom = { parent?: FakeAtom; parentBranch?: string; branches: Record<string, FakeAtom[]>; createBranch(name: string): FakeAtom[] };
	const atom = (parent?: FakeAtom, parentBranch?: string, first = false): FakeAtom => {
		const made: FakeAtom = {
			parent, parentBranch, branches: {},
			createBranch: (name) => (made.branches[name] ??= [atom(made, name, true)]),
		};
		if (parent && parentBranch && !first) parent.createBranch(parentBranch).push(made);
		return made;
	};
	const integral = atom(atom());
	const lower = atom(integral, "subscript");
	const upper = atom(integral, "superscript");
	assert.equal(scriptTarget(lower, "upward"), upper);
	assert.equal(scriptTarget(upper, "downward"), lower);
	// The nearest script wins, through any nesting (x^2 inside the lower limit).
	const power = atom(atom(lower.parent, "subscript"), "superscript");
	assert.equal(scriptTarget(power, "upward"), upper);
	// A missing limit is created (the caret lands on its "first" atom), as MathLive does for \underset.
	const sum = atom(atom());
	const onlyLower = atom(sum, "subscript");
	assert.equal(scriptTarget(onlyLower, "upward"), sum.branches.superscript![0]);
	// Already on top, or not in a script: no target, so the caret leaves the equation.
	assert.equal(scriptTarget(upper, "upward"), undefined);
	assert.equal(scriptTarget(integral, "downward"), undefined);
});

test("Mod+E toggles an equation on any keyboard layout, and only without extra modifiers", () => {
	const key = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;
	assert.equal(isMathToggle(key({ key: "e", code: "KeyE", metaKey: true })), true);
	assert.equal(isMathToggle(key({ key: "e", code: "KeyE", ctrlKey: true })), true);
	// Russian layout: the physical E key reports "у".
	assert.equal(isMathToggle(key({ key: "у", code: "KeyE", metaKey: true })), true);
	assert.equal(isMathToggle(key({ key: "E", code: "KeyE", metaKey: true, shiftKey: true })), false);
	assert.equal(isMathToggle(key({ key: "´", code: "KeyE", metaKey: true, altKey: true })), false);
	assert.equal(isMathToggle(key({ key: "e", code: "KeyE" })), false);
});

test("the Σ button's toggle event inserts an equation at the saved caret and reports it open", async () => {
	const f = await fixture("a b");
	const states: boolean[] = [];
	f.root.addEventListener(MATH_STATE_EVENT, (event) => states.push((event as CustomEvent<{ open: boolean }>).detail.open));
	f.select(1);
	f.doc.getElementById("elsewhere")!.focus(); // the button click took focus away
	await f.event(TOGGLE_MATH_EVENT);
	assert.equal(f.writes[0], "a\\(\\) b");
	assert.equal(states[0], true);
	assert.equal(f.keys, 0, "toggling must not submit");
	// MathLive cannot load under linkedom: the equation closes instead of leaving a dead
	// field, the empty equation leaves no trace, and the box keeps focus.
	assert.deepEqual(states, [true, false]);
	assert.equal(f.value, "a b");
	assert.equal(f.doc.activeElement, f.root);
});

test("the math keyboard unfolds in the typing box, above its anchor row, and lingers while it folds", () => {
	const { window: win, document: doc } = parseHTML(`<html><body>
		<div id="field"><div>YOUR THINKING</div><div id="input" data-file-path-input=""><span id="eq"></span></div></div>
		<div id="card"><form id="row" data-math-keyboard-anchor=""><div data-file-path-input=""><span id="eq2"></span></div></form></div>
	</body></html>`);
	const calls: string[] = [];
	const keyboard = { container: null as Element | null, show: () => calls.push("show"), hide: () => calls.push("hide") };
	const globals = { document: doc, window: Object.assign(win, { mathVirtualKeyboard: keyboard }), requestAnimationFrame: (run: () => void) => run() };
	const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
	for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		// Inner field: directly above the typing line, under the label.
		openKeyboard(doc.getElementById("eq")!);
		const slot = doc.getElementById("input")!.previousElementSibling as HTMLElement;
		assert.equal(slot.className, "lh-math-keyboard");
		assert.equal(keyboard.container, slot.firstElementChild);
		assert.equal(slot.dataset.open, "");
		// Leaving and re-entering an equation in the same box keeps the one keyboard.
		closeKeyboard();
		assert.equal(slot.dataset.open, undefined);
		openKeyboard(doc.getElementById("eq")!);
		mock.timers.tick(1000);
		assert.deepEqual(calls, ["show"]);
		assert.equal(slot.dataset.open, "");
		// Another box: the old keyboard goes at once; the new one sits above the anchor row.
		openKeyboard(doc.getElementById("eq2")!);
		assert.equal(slot.isConnected, false);
		const row = doc.getElementById("row")!;
		assert.equal(row.previousElementSibling?.className, "lh-math-keyboard");
		// Closing folds first and removes the keyboard only after the transition.
		closeKeyboard();
		mock.timers.tick(199);
		assert.equal(row.previousElementSibling?.className, "lh-math-keyboard");
		mock.timers.tick(1);
		assert.equal(row.previousElementSibling, null);
		assert.deepEqual(calls, ["show", "hide", "show", "hide"]);
	} finally {
		mock.timers.reset();
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	}
});
test("clicking another equation while one is open closes the first and opens the clicked one", async () => {
	fakeMathLive();
	const f = await fixture("\\(x\\) and \\(y\\)");
	f.select(0);
	await f.event("keydown", { key: "ArrowRight" });
	await edit(await openField(f), "x+1");
	assert.equal(f.value, "\\(x+1\\) and \\(y\\)");
	await act(async () => { f.root.querySelector('[role="img"][aria-label="y"]')!.dispatchEvent(new f.doc.defaultView!.Event("mousedown", { bubbles: true, cancelable: true })); });
	const second = await openField(f);
	assert.ok(f.root.querySelector('[role="img"][aria-label="x+1"]'), "first chip shows its edit");
	await edit(second, "y2");
	assert.equal(f.value, "\\(x+1\\) and \\(y2\\)");
	await act(async () => { second.dispatchEvent(Object.assign(new f.doc.defaultView!.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" })); });
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "\\(x+1\\) and \\(y\\)");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "\\(x\\) and \\(y\\)");
});

test("clicking an equation while a new empty one is open removes the empty one and opens the clicked one", async () => {
	fakeMathLive();
	const f = await fixture("a \\(y\\)");
	f.select(1);
	await f.event("keydown", { key: "e", ctrlKey: true });
	await openField(f);
	assert.equal(f.value, "a\\(\\) \\(y\\)");
	await act(async () => { f.root.querySelector('[role="img"][aria-label="y"]')!.dispatchEvent(new f.doc.defaultView!.Event("mousedown", { bubbles: true, cancelable: true })); });
	await edit(await openField(f), "y2");
	assert.equal(f.value, "a \\(y2\\)");
});

test("an equation whose editor fails to load closes and gives the keyboard back", async () => {
	fakeMathLive();
	FakeField.fail = true;
	try {
		const f = await fixture("a");
		f.select(1);
		await f.event("keydown", { key: "e", code: "KeyE", ctrlKey: true });
		await settle();
		assert.equal(f.value, "a");
		assert.equal((await f.event("keydown", { key: "b" })).defaultPrevented, false);
	} finally { FakeField.fail = false; }
});

test("an equation toggled inside a code span stays text and undoes in one step", async () => {
	fakeMathLive();
	const f = await fixture("`ab`");
	f.select(2);
	await f.event("keydown", { key: "e", code: "KeyE", ctrlKey: true });
	await settle();
	assert.equal(f.value, "`a\\(\\)b`");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, "`ab`");
});

test("focus that left before the editor mounted stays where it went", async () => {
	fakeMathLive();
	const f = await fixture("\\(x\\)");
	f.select(0);
	await f.event("keydown", { key: "ArrowRight" });
	await settle();
	const field = f.root.querySelector(".lh-math-field > *")!;
	(f.doc.getElementById("elsewhere") as HTMLElement).focus();
	await act(async () => { field.dispatchEvent(new f.doc.defaultView!.Event("mount")); });
	assert.equal(f.doc.activeElement!.id, "elsewhere");
	assert.equal(f.root.querySelector(".lh-math-field"), null);
});

const citationLink = (text: string, comment?: string) => serializeCitation({ version: 1, chatId: "c", messageId: "m", text, start: 0, end: text.length, prefix: "", suffix: "", ...(comment ? { comment } : {}) });

test("tutor citations render as atomic chips that keep their full link source", () => {
	const root = editor();
	const link = citationLink("the derivatives multiply");
	const value = `why ${link} ${quoteFilePath("/a.pdf")}`;
	const hosts = renderPathInput(root, value);
	assert.deepEqual(hosts.map(({ token }) => token.kind), ["citation", "path"]);
	assert.equal(hosts[0]!.host.getAttribute(PATH_SOURCE_ATTRIBUTE), link);
	assert.equal(readPathInput(root), value);
	assert.deepEqual(atomicPathRange(value, { anchor: 6, focus: 6 }), { start: 4, end: 4 + link.length });
	assert.deepEqual(adjacentPathRange(value, { anchor: 4 + link.length, focus: 4 + link.length }, "backward"), { anchor: 4, focus: 4 + link.length });
});

test("citation insertion adds a separating space before and one after, swallowing an existing one", () => {
	const link = citationLink("q");
	const next = insertCitation("ab cd", { anchor: 2, focus: 2 }, link);
	assert.equal(next.value, `ab ${link} cd`);
	assert.deepEqual(next.inserted, { start: 3, end: 3 + link.length, spaceBefore: true, spaceAfter: false });
	assert.equal(next.selection.anchor, 3 + link.length + 1);
	const atEnd = insertCitation("ab ", { anchor: 3, focus: 3 }, link);
	assert.equal(atEnd.value, `ab ${link} `);
	assert.deepEqual(atEnd.inserted, { start: 3, end: 3 + link.length, spaceBefore: false, spaceAfter: true });
});

test("citation events insert, re-comment and remove the chip through the owned history", async () => {
	const f = await fixture("ab");
	f.select(2);
	const link = citationLink("q");
	let inserted: { start: number; end: number; spaceBefore: boolean; spaceAfter: boolean } | undefined;
	await f.event(INSERT_CITATION_EVENT, { detail: { link, onInserted: (range: typeof inserted) => { inserted = range; } } });
	assert.equal(f.value, `ab ${link} `);
	assert.deepEqual(inserted, { start: 3, end: 3 + link.length, spaceBefore: true, spaceAfter: true });
	const commented = citationLink("q", "why");
	await f.event(UPDATE_CITATION_EVENT, { detail: { start: 3, end: 3 + link.length, previous: link, source: commented } });
	assert.equal(f.value, `ab ${commented} `);
	await f.event(UPDATE_CITATION_EVENT, { detail: { start: 3, end: 3 + commented.length, previous: commented, source: null, spaceBefore: true, spaceAfter: true } });
	assert.equal(f.value, "ab");
	await f.event("keydown", { key: "z", metaKey: true });
	assert.equal(f.value, `ab ${commented} `);
});

test("a citation update whose source moved or vanished never edits other text", async () => {
	const link = citationLink("q");
	const f = await fixture(`x ${link}`);
	await f.event(UPDATE_CITATION_EVENT, { detail: { start: 0, end: link.length, previous: link, source: null } });
	assert.equal(f.value, "x ");
	await f.event(UPDATE_CITATION_EVENT, { detail: { start: 2, end: 2 + link.length, previous: link, source: null } });
	assert.equal(f.value, "x ");
});

test("Backspace after a citation chip deletes the whole link", async () => {
	const link = citationLink("q");
	const f = await fixture(`a ${link}`);
	f.select(2 + link.length);
	await f.event("keydown", { key: "Backspace" });
	assert.equal(f.value, "a ");
});
