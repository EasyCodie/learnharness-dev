"use client";

import { messageAnchorId, type ArtifactPartProps } from "@/src/core";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

/** The "remembered: …" line: one muted line; a click opens Settings →
 *  Memory on that memory. Shared by in-chat saves and curator notices. */
export function RememberedLine({ memoryId, text, anchorId }: { memoryId: string; text: string; anchorId?: string }) {
	const { open } = useSettingsDialog();
	return (
		<button
			type="button"
			id={anchorId}
			data-testid="remember-card"
			onClick={() => open("memory", memoryId)}
			className="my-1 block w-full max-w-2xl truncate text-left text-xs text-muted-foreground hover:text-foreground"
		>
			remembered: {text}
		</button>
	);
}

/** A saved memory (the remember tool). Nothing for an error result (the
 *  model retries; nothing was saved). */
export function RememberCard({ part }: ArtifactPartProps) {
	const output = part.output as { ok?: boolean; id?: string; text?: string } | undefined;
	if (part.state !== "output-available" || !output?.ok || !output.id) return null;
	// Settings evidence links land here: /chat/<id>#message-<call id>.
	return <RememberedLine memoryId={output.id} text={output.text ?? ""} anchorId={messageAnchorId(part.toolCallId)} />;
}
