import * as React from "react";
import katex from "katex";
import type { MathfieldElement } from "mathlive";

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
	latex.replace(/\\placeholder(?:\[[^\]]*\])?\{\}/g, "").replace(/(?<!\\)[_^]\{\}/g, "");

export const isMathToggle = (event: KeyboardEvent | React.KeyboardEvent) =>
	(event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "e";

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
			field.value = props.current.latex;
			field.addEventListener("input", () => props.current.onChange(storableLatex(field.getValue("latex-expanded"))));
			field.addEventListener("move-out", (event) => {
				event.preventDefault();
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
				props.current.onReady(field);
			}, { once: true });
			wrap.replaceChildren(field);
		};
		if (mathlive) mount(mathlive);
		else void preloadMathLive().then(mount);
		return () => {
			closed = true;
			wrap.removeEventListener("keydown", intercept, true);
			for (const type of ISOLATED) wrap.removeEventListener(type, stop);
		};
	}, []);

	return <span ref={ref} className="lh-math-field inline-block align-middle" />;
}
