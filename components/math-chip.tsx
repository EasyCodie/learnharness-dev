import * as React from "react";
import katex from "katex";
import type { MathfieldElement } from "mathlive";
import { bindingForAction, eventBinding } from "@/src/core";

export type MathExit = "before" | "after";
export type MathChipProps = {
	latex: string;
	/** Where the caret lands when the live editor opens; null renders the idle KaTeX view. */
	caret: "start" | "end" | null;
	onOpen: () => void;
	onChange: (latex: string) => void;
	/** The field has mounted: keys typed while it was opening can now be sent to it. */
	onReady: (field: MathfieldElement) => void;
	/** refocus=false when focus already left for elsewhere (blur). */
	onExit: (side: MathExit, refocus: boolean) => void;
};

/** Input is MathLive's "latex-expanded" output: standard LaTeX (\differentialD → \mathrm{d})
 * that KaTeX and the model read, minus empty slots. Empty limits are dropped, so a
 * bare \int is an indefinite integral. */
export const storableLatex = (latex: string) =>
	latex.replace(/\\placeholder(?:\[[^\]]*\])?\{\}/g, keepCommandBoundary).replace(/(?<!\\)(?:[_^]\{\})+/g, keepCommandBoundary);
// A removed slot between a command and a letter leaves a space: \int_{}^{}x must not become \intx.
const keepCommandBoundary = (slot: string, at: number, latex: string) =>
	/\\[A-Za-z]+$/.test(latex.slice(0, at)) && /[A-Za-z]/.test(latex[at + slot.length] ?? "") ? " " : "";

/** Reopening: give limitless \int/\sum/\prod their empty limit boxes back (hidden until the caret
 * lands in one; see MathField). A single missing limit is not restored here: ArrowUp/Down recreates it (scriptTarget). */
export const editableLatex = (latex: string) =>
	latex.replace(/\\(int|sum|prod)(?![A-Za-z_^])/g, "\\$1_{\\placeholder{}}^{\\placeholder{}}");

/** The slice of MathLive's internal atom tree that vertical script navigation reads. */
type ScriptAtom = { parent?: ScriptAtom; parentBranch?: unknown; createBranch(name: "subscript" | "superscript"): ScriptAtom[] };
type MathModel = { at(offset: number): ScriptAtom; offsetOf(atom: ScriptAtom): number; setPositionHandlingPlaceholder(offset: number): void };

/** MathLive 0.111's ArrowUp/Down only cross \frac/\underset parts and matrix rows, so the limits of
 * ∫/Σ/∏ (and any x_n^m) were a dead end that left the equation. Returns the atom to put the caret
 * after: the end of the opposite script of the nearest ancestor sitting in a sub/superscript.
 * A missing script is created empty, as MathLive does for \underset; storableLatex drops it if unused. */
export function scriptTarget(atom: ScriptAtom, direction: "upward" | "downward"): ScriptAtom | undefined {
	const [from, to] = direction === "upward" ? ["subscript", "superscript"] as const : ["superscript", "subscript"] as const;
	for (let at: ScriptAtom | undefined = atom; at?.parent; at = at.parent)
		if (at.parentBranch === from) return at.parent.createBranch(to).at(-1);
}

// Registry matching: non-Latin layouts (⌘+у on Russian) still hit the physical E key.
export const isMathToggle = (event: KeyboardEvent) => eventBinding(event) === bindingForAction("equation-toggle");

/** Idle: the transcript's KaTeX rendering. Active: a lazily loaded MathLive field. */
export function MathChip({ latex, caret, ...handlers }: MathChipProps) {
	if (caret) return <MathField latex={latex} caret={caret} {...handlers} />;
	return (
		<span
			role="img"
			aria-label={latex}
			title="Edit equation"
			className="cursor-text rounded px-0.5 hover:bg-muted/60"
			// mousedown, not click: keep the browser from moving the editor caret first.
			onMouseDown={(event) => { event.preventDefault(); handlers.onOpen(); }}
			dangerouslySetInnerHTML={{ __html: katex.renderToString(latex || "\\square", { throwOnError: false, output: "html" }) }}
		/>
	);
}

let mathlive: typeof import("mathlive") | null = null;
/** Called when a box gains focus, so Ctrl+E can open the field before the next keystroke. */
export function preloadMathLive() {
	return import("mathlive").then((module) => {
		// The app's KaTeX stylesheet already provides the same font families.
		module.MathfieldElement.fontsDirectory = null;
		module.MathfieldElement.soundsDirectory = null;
		if (!mathlive) {
			// The keyboard is fixed over the window bottom: publish its height so the app shrinks above it (.h-app).
			const keyboard = window.mathVirtualKeyboard;
			// No "abc" tab: learners type letters on their physical keyboard.
			keyboard.layouts = ["numeric", "symbols", "greek"];
			const sync = () => document.documentElement.style.setProperty("--math-keyboard-height", `${keyboard.boundingRect.height}px`);
			for (const type of ["geometrychange", "virtual-keyboard-toggle"]) keyboard.addEventListener(type, sync);
		}
		return (mathlive = module);
	});
}

// Events the outer plaintext editor must never see while the field owns input.
const ISOLATED = ["keydown", "keyup", "beforeinput", "input", "paste", "copy", "cut", "compositionstart", "compositionend"];

function MathField({ latex, caret, onChange, onExit, onReady }: Omit<MathChipProps, "onOpen"> & { caret: "start" | "end" }) {
	const ref = React.useRef<HTMLSpanElement>(null);
	const props = React.useRef({ latex, caret, onChange, onExit, onReady });
	props.current = { latex, caret, onChange, onExit, onReady };

	React.useEffect(() => {
		const wrap = ref.current!;
		let closed = false;
		const exit = (side: MathExit, refocus: boolean) => {
			if (closed) return;
			closed = true;
			props.current.onExit(side, refocus);
		};
		const stop = (event: Event) => event.stopPropagation();
		// Capture on an ancestor runs before MathLive's own handlers inside its shadow root.
		const intercept = (event: KeyboardEvent) => {
			if (event.isComposing) return;
			if ((event.key === "Enter" && !event.shiftKey) || isMathToggle(event)) {
				event.preventDefault();
				event.stopPropagation();
				exit("after", true);
			}
		};
		wrap.addEventListener("keydown", intercept, true);
		for (const type of ISOLATED) wrap.addEventListener(type, stop);
		const mount = ({ MathfieldElement }: typeof import("mathlive")) => {
			if (closed) return;
			const field = new MathfieldElement();
			field.mathVirtualKeyboardPolicy = "manual";
			field.value = editableLatex(props.current.latex);
			// Empty boxes are invisible until the caret is on one. MathLive styles no unselected
			// placeholder, so the symbol itself toggles: while one is selected, all show.
			const showEmptyBoxes = () => {
				const symbol = field.getValue(field.selection) === "\\placeholder{}" ? "\u25A2" : "";
				if (field.placeholderSymbol !== symbol) field.placeholderSymbol = symbol;
			};
			showEmptyBoxes();
			field.addEventListener("selection-change", showEmptyBoxes);
			field.addEventListener("input", () => props.current.onChange(storableLatex(field.getValue("latex-expanded"))));
			field.addEventListener("move-out", (event) => {
				event.preventDefault();
				const { direction } = event.detail;
				if (direction === "upward" || direction === "downward") {
					// shortcut: reads MathLive's private model (pinned ^0.111); recheck on a MathLive upgrade.
					const model = (field as unknown as { _mathfield?: { model?: MathModel } })._mathfield?.model;
					const target = model && scriptTarget(model.at(field.position), direction);
					if (target) return model.setPositionHandlingPlaceholder(model.offsetOf(target));
				}
				exit(event.detail.direction === "backward" || event.detail.direction === "upward" ? "before" : "after", true);
			});
			field.addEventListener("focusout", () => queueMicrotask(() => {
				// The virtual keyboard and menus keep focus logically inside the field.
				if (!field.hasFocus()) exit("after", false);
			}));
			// MathLive ignores focus() until it has mounted (~hundreds of ms on first use).
			field.addEventListener("mount", () => {
				if (closed) return;
				field.focus();
				field.position = props.current.caret === "start" ? 0 : field.lastOffset;
				// The math keyboard opens and closes with the equation (closed in the cleanup below).
				window.mathVirtualKeyboard.show();
				props.current.onReady(field);
			}, { once: true });
			wrap.replaceChildren(field);
		};
		if (mathlive) mount(mathlive);
		else void preloadMathLive().then(mount);
		return () => {
			closed = true;
			window.mathVirtualKeyboard?.hide();
			wrap.removeEventListener("keydown", intercept, true);
			for (const type of ISOLATED) wrap.removeEventListener(type, stop);
		};
	}, []);

	return <span ref={ref} className="lh-math-field inline-block align-middle" />;
}
