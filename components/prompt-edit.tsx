"use client";

import { useRef, useState } from "react";
import { PathInput } from "@/components/path-input";
import { MathToggleButton } from "@/components/math-toggle-button";
import { AttachFilesButton } from "@/components/attach-files-button";

/** The restored prompt goes first; a draft typed since stays below it. */
export function withRestoredPrompt(prompt: string, draft: string): string {
	const rest = draft.trim();
	return rest ? `${prompt}\n\n${rest}` : prompt;
}

/**
 * Inline Edit of the last prompt (owner, 2026-11-10): the YOU block's
 * text becomes the composer's own PathInput (chips and equations stay
 * editable). Enter sends, Shift+Enter is a newline, Esc cancels — the
 * composer's conventions.
 */
export function PromptEditor({ initial, onSend, onCancel }: {
	initial: string;
	onSend: (text: string) => void;
	onCancel: () => void;
}) {
	const editorRef = useRef<HTMLDivElement>(null);
	const [value, setValue] = useState(initial);
	const send = () => {
		const t = value.trim();
		if (t) onSend(t);
	};
	return (
		<div data-testid="prompt-editor" className="mt-1">
			<div className="flex items-end gap-1 rounded-md border border-border bg-background">
				<PathInput
					ref={editorRef}
					value={value}
					onValueChange={setValue}
					autoFocus
					aria-label="Edit your message"
					onKeyDown={(e) => {
						// Claim Esc so the window-level chain never reads it as an abort.
						if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							onCancel();
							return;
						}
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
							e.preventDefault();
							send();
						}
					}}
					className="field-sizing-content lh-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none"
				/>
				<MathToggleButton editorRef={editorRef} />
				<AttachFilesButton editorRef={editorRef} />
			</div>
			<div className="mt-1.5 flex justify-end gap-2">
				<button
					type="button"
					data-testid="prompt-edit-cancel"
					onClick={onCancel}
					className="rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Cancel
				</button>
				<button
					type="button"
					data-testid="prompt-edit-send"
					onClick={send}
					disabled={!value.trim()}
					className="rounded-sm border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
				>
					Send
				</button>
			</div>
		</div>
	);
}
