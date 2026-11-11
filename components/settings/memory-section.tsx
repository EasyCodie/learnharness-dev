"use client";
/**
 * Settings → Memory (learner memory plan, 2026-11-10): the master switch,
 * a plain "Add memory" form, and the memory tree (Profile, then each
 * subject with its areas). Every memory can be edited, moved and deleted.
 * Refetches on "memory-changed".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MEMORY_KINDS, MEMORY_KIND_LABELS, messageAnchorId, type MemoryKind, type MemoryLevel, type MemoryRow, type MemoryView } from "@/src/core";
import { useServerEvent } from "@/components/server-events";
import { CommitInput, SettingsGroup, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

const NEW = "__new__";
const linkClass = "text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";
const fieldClass = "h-7 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60";

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
	const res = await fetch(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	if (res.ok) return null;
	const detail = (await res.json().catch(() => ({}))) as { error?: string };
	return detail.error ?? `status ${res.status}`;
}

export function MemorySection({
	enabled,
	onEnabledChange,
	initialRow,
	initialView,
}: {
	enabled: boolean;
	onEnabledChange: (on: boolean) => void;
	/** Memory id to land on, expanded (the "remembered: …" deep link). */
	initialRow?: string;
	/** Render tests pass the tree directly (no fetch under SSR). */
	initialView?: MemoryView;
}) {
	const [view, setView] = useState<MemoryView | null>(initialView ?? null);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(() => {
		fetch("/api/memory")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
			.then((body: MemoryView) => setView(body))
			.catch((e: Error) => setError(e.message));
	}, []);
	useEffect(() => { if (!initialView) load(); }, [initialView, load]);
	useServerEvent("memory-changed", load);

	const act = useCallback(async (url: string, method: string, body?: unknown) => {
		setError(null);
		const problem = await send(url, method, body);
		if (problem) setError(problem);
		else load();
		return problem === null;
	}, [load]);

	const subjects = view?.subjects.map((s) => s.name) ?? [];
	const areasFor = (subject: string) => view?.subjects.find((s) => s.name === subject)?.areas.map((a) => a.name) ?? [];
	const rowProps = { open: initialRow, act, subjects, areasFor };

	return (
		<>
			<SettingsRow label="Remember me across sessions" hint="Off: no memory tools or memory text reach the agents. Saved memories are kept.">
				<Toggle checked={enabled} onChange={onEnabledChange} label="Memory" />
			</SettingsRow>
			{error && <p role="alert" data-testid="memory-error" className="whitespace-pre-wrap text-xs text-red-500">{error}</p>}
			{view?.error && <p role="alert" data-testid="memory-unavailable" className="text-xs text-red-500">{view.error}</p>}
			{view && !view.error && (
				<>
					<AddMemory act={act} subjects={subjects} areasFor={areasFor} profileFull={view.profile.length >= view.profileCap} />
					<SettingsGroup label={`Profile (${view.profile.length} / ${view.profileCap})`} testid="memory-profile">
						{view.profile.length === 0 && <p className="text-xs text-muted-foreground/70">Nothing yet.</p>}
						{view.profile.map((m) => <MemoryItem key={m.id} memory={m} {...rowProps} />)}
					</SettingsGroup>
					{view.subjects.map((subject) => (
						<SettingsGroup key={subject.name} label={subject.name} testid={`memory-subject-${subject.name}`}>
							{subject.memories.map((m) => <MemoryItem key={m.id} memory={m} {...rowProps} />)}
							{subject.areas.map((area) => (
								<details key={area.name} open={area.memories.some((m) => m.id === initialRow) || undefined} className="group" data-testid={`memory-area-${area.name}`}>
									<summary className="cursor-pointer list-none text-xs text-foreground [&::-webkit-details-marker]:hidden">
										<span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
										{area.name} <span className="text-muted-foreground">({area.memories.length})</span>
									</summary>
									<div className="ml-3 mt-2 flex flex-col gap-2">
										<CommitInput
											value={area.description}
											ariaLabel={`Description of ${area.name}`}
											onCommit={(description) => act("/api/memory/areas", "PUT", { subject: subject.name, area: area.name, description })}
										/>
										{area.memories.map((m) => <MemoryItem key={m.id} memory={m} {...rowProps} />)}
									</div>
								</details>
							))}
						</SettingsGroup>
					))}
				</>
			)}
		</>
	);
}

type Act = (url: string, method: string, body?: unknown) => Promise<boolean>;

interface Placement {
	level: MemoryLevel;
	subject: string;
	newSubject: string;
	area: string;
	newArea: string;
	newAreaDescription: string;
}

const EMPTY_PLACEMENT: Placement = { level: "profile", subject: "", newSubject: "", area: "", newArea: "", newAreaDescription: "" };

function placementBody(p: Placement) {
	if (p.level === "profile") return { level: p.level };
	const isNewSubject = p.subject === NEW || p.subject === "";
	const subject = isNewSubject ? p.newSubject : p.subject;
	if (p.level === "subject") return { level: p.level, subject, newSubject: isNewSubject };
	const isNewArea = p.area === NEW || p.area === "";
	return isNewArea
		? { level: p.level, subject, newSubject: isNewSubject, area: p.newArea, newAreaDescription: p.newAreaDescription }
		: { level: p.level, subject, newSubject: isNewSubject, area: p.area };
}

function PlacementPicker({ value, onChange, subjects, areasFor }: { value: Placement; onChange: (p: Placement) => void; subjects: string[]; areasFor: (s: string) => string[] }) {
	const set = (patch: Partial<Placement>) => onChange({ ...value, ...patch });
	const subject = value.subject || (subjects[0] ?? NEW);
	const areas = subject === NEW ? [] : areasFor(subject);
	const area = value.area || (areas[0] ?? NEW);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<ThinSelect value={value.level} ariaLabel="Level" onChange={(level) => set({ level: level as MemoryLevel })}>
				<option value="profile">Profile</option>
				<option value="subject">Subject</option>
				<option value="area">Area</option>
			</ThinSelect>
			{value.level !== "profile" && (
				<ThinSelect value={subject} ariaLabel="Subject" onChange={(s) => set({ subject: s, area: "" })}>
					{subjects.map((s) => <option key={s} value={s}>{s}</option>)}
					<option value={NEW}>New…</option>
				</ThinSelect>
			)}
			{value.level !== "profile" && subject === NEW && (
				<input className={fieldClass} placeholder="Subject name" aria-label="New subject name" value={value.newSubject} onChange={(e) => set({ newSubject: e.target.value })} />
			)}
			{value.level === "area" && (
				<ThinSelect value={area} ariaLabel="Area" onChange={(a) => set({ area: a })}>
					{areas.map((a) => <option key={a} value={a}>{a}</option>)}
					<option value={NEW}>New…</option>
				</ThinSelect>
			)}
			{value.level === "area" && area === NEW && (
				<>
					<input className={fieldClass} placeholder="Area name" aria-label="New area name" value={value.newArea} onChange={(e) => set({ newArea: e.target.value })} />
					<input className={`${fieldClass} w-64`} placeholder="What the area covers (one line)" aria-label="New area description" value={value.newAreaDescription} onChange={(e) => set({ newAreaDescription: e.target.value })} />
				</>
			)}
		</div>
	);
}

/** Resolve the picker's implicit defaults (first subject/area) before sending. */
function resolved(p: Placement, subjects: string[], areasFor: (s: string) => string[]): Placement {
	const subject = p.subject || (subjects[0] ?? NEW);
	const area = p.area || ((subject === NEW ? [] : areasFor(subject))[0] ?? NEW);
	return { ...p, subject, area };
}

function AddMemory({ act, subjects, areasFor, profileFull }: { act: Act; subjects: string[]; areasFor: (s: string) => string[]; profileFull: boolean }) {
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<MemoryKind>("preference");
	const [text, setText] = useState("");
	const [place, setPlace] = useState<Placement>(EMPTY_PLACEMENT);
	if (!open) {
		return <button type="button" className={`${linkClass} self-start`} data-testid="memory-add-open" onClick={() => setOpen(true)}>Add memory</button>;
	}
	const blocked = place.level === "profile" && profileFull;
	return (
		<div className="flex flex-col gap-2 rounded-sm border border-border p-3" data-testid="memory-add">
			<div className="flex flex-wrap items-center gap-2">
				<ThinSelect value={kind} ariaLabel="Kind" onChange={(k) => setKind(k as MemoryKind)}>
					{MEMORY_KINDS.map((k) => <option key={k} value={k}>{MEMORY_KIND_LABELS[k]}</option>)}
				</ThinSelect>
				<PlacementPicker value={place} onChange={setPlace} subjects={subjects} areasFor={areasFor} />
			</div>
			<textarea className={`${fieldClass} h-16 py-1`} aria-label="Memory text" placeholder="One specific sentence" value={text} onChange={(e) => setText(e.target.value)} />
			{blocked && <p className="text-xs text-muted-foreground">The Profile is full. Delete or move one first, or file this under a subject.</p>}
			<div className="flex gap-3">
				<button
					type="button"
					className={linkClass}
					disabled={blocked || !text.trim()}
					onClick={async () => {
						const ok = await act("/api/memory", "POST", { kind, text, ...placementBody(resolved(place, subjects, areasFor)) });
						if (ok) { setText(""); setOpen(false); setPlace(EMPTY_PLACEMENT); }
					}}
				>Save</button>
				<button type="button" className={linkClass} onClick={() => setOpen(false)}>Cancel</button>
			</div>
		</div>
	);
}

function evidenceLine(e: MemoryRow["evidence"][number]) {
	// Settings entries carry their own wording: "Added by you in Settings" / "Edited by you in Settings".
	if (e.where === "settings") return <span>{e.note || "Added by you in Settings"}</span>;
	if (e.where === "deleted") return <span>from a deleted session</span>;
	const href = `/chat/${encodeURIComponent(e.where.chatId)}${e.where.anchor ? `#${encodeURIComponent(messageAnchorId(e.where.anchor))}` : ""}`;
	return <a className="underline-offset-2 hover:underline" href={href}>{e.where.chatTitle}</a>;
}

function MemoryItem({ memory, open, act, subjects, areasFor }: { memory: MemoryRow; open?: string; act: Act; subjects: string[]; areasFor: (s: string) => string[] }) {
	const [mode, setMode] = useState<"view" | "edit" | "move" | "delete">("view");
	const [draft, setDraft] = useState(memory.text);
	const [place, setPlace] = useState<Placement>(EMPTY_PLACEMENT);
	const ref = useRef<HTMLDetailsElement | null>(null);
	const landed = open === memory.id;
	useEffect(() => { if (landed) ref.current?.scrollIntoView({ block: "center" }); }, [landed]);
	const url = `/api/memory/${encodeURIComponent(memory.id)}`;
	return (
		<details ref={ref} open={landed || undefined} className="group/m" data-testid={`memory-${memory.id}`}>
			<summary className="flex cursor-pointer list-none items-baseline gap-2 text-xs [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-muted-foreground">{MEMORY_KIND_LABELS[memory.kind]}</span>
				<span className="min-w-0 flex-1 font-prose text-(length:--lh-prose-size)">{memory.text}</span>
				<span className="shrink-0 text-muted-foreground/70">{memory.at.slice(0, 10)}</span>
			</summary>
			<div className="ml-3 mt-2 flex flex-col gap-2 text-xs text-muted-foreground">
				<ul className="flex flex-col gap-1" data-testid="memory-evidence">
					{memory.evidence.map((e, i) => (
						<li key={i}>{e.at.slice(0, 10)} · {evidenceLine(e)}{e.note && e.where !== "settings" ? ` — ${e.note}` : ""}</li>
					))}
				</ul>
				{mode === "edit" && (
					<div className="flex flex-col gap-2">
						<textarea className={`${fieldClass} h-16 py-1`} aria-label="Edit memory text" value={draft} onChange={(e) => setDraft(e.target.value)} />
						<div className="flex gap-3">
							<button type="button" className={linkClass} disabled={!draft.trim()} onClick={async () => { if (await act(url, "PUT", { text: draft })) setMode("view"); }}>Save</button>
							<button type="button" className={linkClass} onClick={() => setMode("view")}>Cancel</button>
						</div>
					</div>
				)}
				{mode === "move" && (
					<div className="flex flex-col gap-2">
						<PlacementPicker value={place} onChange={setPlace} subjects={subjects} areasFor={areasFor} />
						<div className="flex gap-3">
							<button type="button" className={linkClass} onClick={async () => { if (await act(url, "PUT", { move: placementBody(resolved(place, subjects, areasFor)) })) setMode("view"); }}>Move</button>
							<button type="button" className={linkClass} onClick={() => setMode("view")}>Cancel</button>
						</div>
					</div>
				)}
				{mode === "delete" && (
					<div className="flex gap-3">
						<span>Delete this memory?</span>
						<button type="button" className={linkClass} data-testid="memory-delete-confirm" onClick={() => void act(url, "DELETE")}>Delete</button>
						<button type="button" className={linkClass} onClick={() => setMode("view")}>Cancel</button>
					</div>
				)}
				{mode === "view" && (
					<div className="flex items-center gap-3">
						<button type="button" className={linkClass} onClick={() => { setDraft(memory.text); setMode("edit"); }}>Edit</button>
						<button type="button" className={linkClass} onClick={() => setMode("move")}>Move</button>
						<ThinSelect value={memory.kind} ariaLabel="Change kind" onChange={(kind) => void act(url, "PUT", { kind })}>
							{MEMORY_KINDS.map((k) => <option key={k} value={k}>{MEMORY_KIND_LABELS[k]}</option>)}
						</ThinSelect>
						<button type="button" className={linkClass} onClick={() => setMode("delete")}>Delete</button>
					</div>
				)}
			</div>
		</details>
	);
}
