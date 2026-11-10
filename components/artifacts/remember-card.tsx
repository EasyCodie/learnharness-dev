"use client";

import type { ArtifactPartProps } from "@/src/core";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

/** A saved memory: one muted line; a click opens Settings → Memory on it.
 *  Nothing for an error result (the model retries; nothing was saved). */
export function RememberCard({ part }: ArtifactPartProps) {
	const { open } = useSettingsDialog();
	const output = part.output as { ok?: boolean; id?: string; text?: string } | undefined;
	if (part.state !== "output-available" || !output?.ok || !output.id) return null;
	return (
		<button
			type="button"
			data-testid="remember-card"
			onClick={() => open("memory", output.id)}
			className="my-1 block w-full max-w-2xl truncate text-left text-xs text-muted-foreground hover:text-foreground"
		>
			remembered: {output.text}
		</button>
	);
}
