"use client";

import { useSyncExternalStore } from "react";
import { XIcon } from "lucide-react";
import type { ImageContent } from "@earendil-works/pi-ai";
import { BrailleSpinner } from "./braille-spinner";
import { cn } from "../lib/utils";

/**
 * Pictures attached to an answer field but not yet submitted (owner,
 * 2026-11-13). The bytes are captured the moment a picture is attached, so
 * the source file may vanish afterwards (a temporary shelf). In memory only:
 * a reload drops them. A field is whatever element carries
 * `data-image-field`; its value keys the entries, so a picture belongs to one
 * question or problem and never leaks into the next.
 * shortcut: entries of a field that is never submitted live until the page
 * unloads; add eviction if abandoned drafts ever pile up.
 */
export interface PendingImage { id: number; name: string; /** Absent while the server prepares it. */ image?: ImageContent }

export const IMAGE_FIELD_ATTRIBUTE = "data-image-field";
const EMPTY: readonly PendingImage[] = [];
const fields = new Map<string, readonly PendingImage[]>();
const errors = new Map<string, string>();
const preparing = new Map<string, Set<Promise<void>>>();
const listeners = new Set<() => void>();
let nextId = 0;

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const entries = (field: string) => fields.get(field) ?? EMPTY;
function set(field: string, next: readonly PendingImage[]) {
	if (next.length) fields.set(field, next); else fields.delete(field);
	for (const listener of listeners) listener();
}

/** Formats the prepare route can turn into a native image; anything else stays a file path. */
export function isImageFile(file: File): boolean {
	return /^image\/(png|jpeg|gif|webp|bmp|heic|heif)$/.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/** Take the pictures among `files` into the image field around `target`.
 * Returns the files left for the path flow: all of them outside an image field. */
export function attachImages(target: Element | null | undefined, files: readonly File[]): File[] {
	const field = target?.closest(`[${IMAGE_FIELD_ATTRIBUTE}]`)?.getAttribute(IMAGE_FIELD_ATTRIBUTE);
	if (!field) return [...files];
	for (const file of files) if (isImageFile(file)) addPendingImage(field, file);
	return files.filter(file => !isImageFile(file));
}

function addPendingImage(field: string, file: File): void {
	const id = ++nextId;
	errors.delete(field);
	set(field, [...entries(field), { id, name: file.name }]);
	const work = (async () => {
		try {
			const response = await fetch("/api/images/prepare", { method: "POST", body: file });
			const body = await response.json() as { data?: string; mimeType?: string; error?: string };
			if (!response.ok || !body.data || !body.mimeType) throw new Error(body.error);
			const image: ImageContent = { type: "image", data: body.data, mimeType: body.mimeType };
			// An entry removed while preparing stays removed.
			set(field, entries(field).map(entry => entry.id === id ? { ...entry, image } : entry));
		} catch (error) {
			errors.set(field, (error instanceof Error && error.message) || "Could not add that image.");
			set(field, entries(field).filter(entry => entry.id !== id));
		}
	})();
	const running = preparing.get(field) ?? new Set();
	preparing.set(field, running.add(work));
	void work.finally(() => running.delete(work));
}

export function removePendingImage(field: string, id: number): void {
	errors.delete(field);
	set(field, entries(field).filter(entry => entry.id !== id));
}

/** The field's pictures for a submission, waiting for any still being prepared. */
export async function takePendingImages(field: string | undefined): Promise<ImageContent[]> {
	if (!field) return [];
	await Promise.all(preparing.get(field) ?? []);
	return entries(field).flatMap(entry => entry.image ? [entry.image] : []);
}

/** After the server accepted a submission: drop exactly the pictures it carried. */
export function clearPendingImages(field: string | undefined, sent: readonly ImageContent[]): void {
	if (field && sent.length) set(field, entries(field).filter(entry => !entry.image || !sent.includes(entry.image)));
}

export function usePendingImages(field: string | undefined): readonly PendingImage[] {
	const read = () => field ? entries(field) : EMPTY;
	// Nothing attaches during a server render, so both snapshots are the store.
	return useSyncExternalStore(subscribe, read, read);
}

/** The field's thumbnails, each removable, plus the last attach failure. */
export function PendingImages({ field, className }: { field: string | undefined; className?: string }) {
	const images = usePendingImages(field);
	const readError = () => (field && errors.get(field)) || "";
	const error = useSyncExternalStore(subscribe, readError, readError);
	if (!field || (!images.length && !error)) return null;
	return (
		<div data-testid="pending-images" className={cn("flex flex-wrap items-center gap-2 px-2.5 pb-1", className)}>
			{images.map(entry => (
				<div key={entry.id} title={entry.name} className="relative size-14 overflow-hidden rounded-[6px] border border-border/70 bg-muted">
					{entry.image
						// Local data URL of already-normalized bytes; nothing to optimize.
						// eslint-disable-next-line @next/next/no-img-element
						? <img src={`data:${entry.image.mimeType};base64,${entry.image.data}`} alt={entry.name} draggable={false} className="size-full object-cover" />
						: <span className="flex size-full items-center justify-center text-muted-foreground"><BrailleSpinner /></span>}
					<button type="button" aria-label={`Remove ${entry.name}`} onClick={() => removePendingImage(field, entry.id)}
						className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background/90 text-foreground hover:bg-accent">
						<XIcon className="size-3" />
					</button>
				</div>
			))}
			{error && <span role="status" className="text-xs text-destructive">{error}</span>}
		</div>
	);
}
