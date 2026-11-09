"use client";

import { useEffect, useState } from "react";
import { SigmaIcon } from "lucide-react";
import { Hint } from "@/components/ui/hint";
import { MATH_STATE_EVENT, TOGGLE_MATH_EVENT } from "@/components/path-input";
import { cn } from "@/lib/utils";

/**
 * The Σ button (owner 2026-11-09): Mod+E's twin. Inserts an equation at the
 * caret of `editorRef` (a PathInput root), or leaves the open one; pressed
 * while that box has an equation open.
 */
export function MathToggleButton({ editorRef, className }: { editorRef: React.RefObject<HTMLDivElement | null>; className?: string }) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const sync = (event: Event) => {
			if (event.target === editorRef.current) setOpen((event as CustomEvent<{ open: boolean }>).detail.open);
		};
		document.addEventListener(MATH_STATE_EVENT, sync);
		return () => document.removeEventListener(MATH_STATE_EVENT, sync);
	}, [editorRef]);
	return (
		<Hint label="LaTeX Rendering" action="equation-toggle">
			<button
				type="button"
				aria-label="LaTeX Rendering"
				aria-pressed={open}
				data-testid="math-toggle"
				// A mousedown would blur the open equation and close it before the click lands.
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => editorRef.current?.dispatchEvent(new CustomEvent(TOGGLE_MATH_EVENT))}
				className={cn(
					"flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground",
					className,
				)}
			>
				<SigmaIcon className="size-4" />
			</button>
		</Hint>
	);
}
