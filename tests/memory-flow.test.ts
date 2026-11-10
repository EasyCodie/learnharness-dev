/**
 * Learner memory end to end (plan 2026-11-10 tasks 5–7): the handler's
 * prompt block and tools, a scripted turn that saves, Undo purging what the
 * removed turn saved, session deletion keeping memories, and the Settings
 * routes. Isolated LH_DATA_DIR; every app import is dynamic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-memory-flow-"));
process.env.LH_DATA_DIR = TMP;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { undoLastPrompt, deleteChatSession } = await import("../src/server/chats.ts");
const { readMemoryView } = await import("../src/server/memory.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { memoryTools } = await import("../src/agent/tools/memory.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { memoryStore } = await import("../src/store/memory.ts");
const { settingsStore } = await import("../src/store/settings.ts");
const { applyRemember, emptyMemoryFile, memoryText } = await import("../src/core/memory.ts");
const { undoableTail } = await import("../src/core/prompt-undo.ts");
const memoryRoute = await import("../app/api/memory/route.ts");
const memoryIdRoute = await import("../app/api/memory/[id]/route.ts");
const areasRoute = await import("../app/api/memory/areas/route.ts");
type BuildOpts = Parameters<NonNullable<Parameters<typeof handleChatRequest>[1]>>[0];

after(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => {
	memoryStore.write(emptyMemoryFile());
	settingsStore.writeSettings({ version: 1 });
});

function chat() {
	const c = chatStore.createChat("Waves");
	chatStore.saveSettings(c.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return c.id;
}

function post(chatId: string, text: string): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text } }),
	});
}

/** One turn: the scripted steps run through the handler; the factory sees
 *  the build options (memory block + tool context) the handler computed. */
async function turn(chatId: string, text: string, steps: FauxResponseStep[]): Promise<BuildOpts> {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	let seen: BuildOpts | undefined;
	const factory = (opts: BuildOpts) => {
		seen = opts;
		return createTeacherAgent(undefined, {
			engine: { model: faux.getModel(), streamFn: faux.streamSimple },
			messages: opts.messages,
			...(opts.memory ? { tools: memoryTools(opts.memory) } : {}),
			...(opts.memoryBlock ? { memoryBlock: opts.memoryBlock } : {}),
		});
	};
	const ack = await handleChatRequest(post(chatId, text), factory);
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	return seen!;
}

const say = (t: string) => fauxAssistantMessage([fauxText(t)]);
const calls = (...c: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(c, { stopReason: "toolUse" });

describe("memory through the chat handler", () => {
	it("memory off: no block and no tools; on: the Profile, then the subject index once set", async () => {
		const id = chat();
		settingsStore.writeSettings({ version: 1, memory: { enabled: false } });
		const off = await turn(id, "hi", [say("hello")]);
		assert.equal(off.memoryBlock, undefined);
		assert.equal(off.memory, undefined);

		settingsStore.writeSettings({ version: 1 });
		const on = await turn(id, "I study physics", [calls(fauxToolCall("memory_subject", { subject: "Physics", new: true }, { id: "toolu_s1" })), say("ok")]);
		assert.match(on.memoryBlock!, /### Profile \(0 of 15\)[\s\S]*not set/);
		const next = await turn(id, "go on", [say("ok")]);
		assert.match(next.memoryBlock!, /### This session's subject: Physics\nNew subject, no memories yet\./);
	});

	it("the composed prompt is unchanged without a memory block", () => {
		const engine = { model: createFauxCore({}).getModel(), streamFn: (() => {}) as never };
		const plain = createTeacherAgent(undefined, { engine }).state.systemPrompt;
		const withBlock = createTeacherAgent(undefined, { engine, memoryBlock: "## Memory\nX" }).state.systemPrompt;
		assert.equal(withBlock, `${plain}\n\n---\n\n## Memory\nX`);
	});

	it("a scripted remember is saved with the saved record's call id as evidence; Undo removes it", async () => {
		const id = chat();
		await turn(id, "always draw first", [calls(fauxToolCall("remember", { text: "Wants a diagram first.", kind: "preference", level: "profile", note: "He said so." }, { id: "toolu_r1" })), say("noted")]);
		const record = chatStore.getChat(id)!;
		const savedCallIds = record.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id) : []));
		const [memory] = memoryStore.read().memories;
		assert.ok(memory);
		assert.ok(savedCallIds.includes(memory.entries[0]!.source!.ref), "evidence cites a call that is in the saved record");

		const tail = undoableTail(record.messages)!;
		const outcome = await undoLastPrompt(id, tail.promptId);
		assert.ok(outcome.ok);
		assert.equal(outcome.memoriesRemoved, 1);
		assert.deepEqual(memoryStore.read(), emptyMemoryFile());
	});

	it("Undo of a replaces save restores the earlier wording; a new area disappears; others are untouched", async () => {
		const id = chat();
		await turn(id, "I like diagrams", [calls(fauxToolCall("remember", { text: "Likes diagrams.", kind: "preference", level: "profile", note: "n" }, { id: "toolu_a" })), say("ok")]);
		const memId = memoryStore.read().memories[0]!.id;
		// Settings-added memory and another chat's memory: never touched by this chat's Undo.
		let file = memoryStore.read();
		for (const [text, ctx] of [["by hand", { at: "t", by: "learner" }], ["other chat", { at: "t", by: "agent", source: { chatId: "chat_other", ref: "toolu_z" } }]] as const) {
			const r = applyRemember(file, { text, kind: "preference", level: "profile", note: "n" }, ctx);
			assert.ok(!("problems" in r));
			file = r.file;
		}
		memoryStore.write(file);

		await turn(id, "actually sketches, and for physics waves too", [
			calls(
				fauxToolCall("remember", { text: "Likes rough sketches.", kind: "preference", level: "profile", replaces: memId, note: "n" }, { id: "toolu_b" }),
				fauxToolCall("memory_subject", { subject: "Physics", new: true }, { id: "toolu_c" }),
			),
			calls(fauxToolCall("remember", { text: "Wants animations.", kind: "preference", level: "area", area: "Waves", newAreaDescription: "Interference", note: "n" }, { id: "toolu_d" })),
			say("ok"),
		]);
		assert.equal(memoryText(memoryStore.read().memories.find((m) => m.id === memId)!), "Likes rough sketches.");
		assert.deepEqual(memoryStore.read().areas, { Physics: { Waves: "Interference" } });

		const outcome = await undoLastPrompt(id, undoableTail(chatStore.getChat(id)!.messages)!.promptId);
		assert.ok(outcome.ok);
		const after = memoryStore.read();
		assert.equal(memoryText(after.memories.find((m) => m.id === memId)!), "Likes diagrams.");
		assert.deepEqual(after.areas, {});
		assert.deepEqual(after.memories.map(memoryText).sort(), ["Likes diagrams.", "by hand", "other chat"]);
	});

	it("deleting a session keeps its memories; evidence resolves to deleted", async () => {
		const id = chat();
		await turn(id, "remember I'm aiming for a 7", [calls(fauxToolCall("remember", { text: "Aiming for a 7.", kind: "preference", level: "profile", note: "n" }, { id: "toolu_e" })), say("ok")]);
		const live = readMemoryView().profile[0]!.evidence[0]!.where;
		assert.ok(typeof live === "object" && live.chatTitle === "Waves" && live.anchor === memoryStore.read().memories[0]!.entries[0]!.source!.ref);
		const outcome = await deleteChatSession(id, "delete-nodes");
		assert.ok(outcome.ok);
		assert.equal(memoryStore.read().memories.length, 1);
		assert.equal(readMemoryView().profile[0]!.evidence[0]!.where, "deleted");
	});
});

describe("Settings → Memory routes", () => {
	const json = (method: string, body?: unknown) =>
		new Request("http://test/api/memory", { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const params = (id: string) => ({ params: Promise.resolve({ id }) });

	it("add, edit text and kind, move, delete; refusals", async () => {
		assert.equal((await memoryRoute.POST(json("POST", { kind: "nope", level: "profile", text: "x" }))).status, 400);
		assert.equal((await memoryRoute.POST(json("POST", { kind: "preference", level: "subject", subject: "Econ", text: "x" }))).status, 400);
		const added = await memoryRoute.POST(json("POST", { kind: "preference", level: "subject", subject: "Economics", newSubject: true, text: "Aiming for a 7." }));
		assert.equal(added.status, 200);
		const { id } = (await added.json()) as { id: string };
		assert.equal(readMemoryView().subjects[0]!.memories[0]!.evidence[0]!.where, "settings");

		assert.equal((await memoryIdRoute.PUT(json("PUT", { text: "Aiming for a 6." }), params(id))).status, 200);
		assert.equal((await memoryIdRoute.PUT(json("PUT", { kind: "knowledge" }), params(id))).status, 200);
		assert.equal((await memoryIdRoute.PUT(json("PUT", { move: { level: "area", subject: "economics", area: "Unit 4", newAreaDescription: "Macro" } }), params(id))).status, 200);
		const moved = memoryStore.read().memories[0]!;
		assert.deepEqual([moved.kind, moved.subject, moved.area, moved.placedByLearner, memoryText(moved)], ["knowledge", "Economics", "Unit 4", true, "Aiming for a 6."]);
		assert.equal((await memoryIdRoute.PUT(json("PUT", { move: { level: "area", subject: "Economics", area: "Unknown" } }), params(id))).status, 400);
		assert.equal((await memoryIdRoute.PUT(json("PUT", { text: "x" }), params("m_none00"))).status, 404);

		assert.equal((await memoryIdRoute.DELETE(json("DELETE"), params(id))).status, 200);
		assert.deepEqual(memoryStore.read(), emptyMemoryFile());
		assert.equal((await memoryIdRoute.DELETE(json("DELETE"), params(id))).status, 404);
	});

	it("the Profile cap applies to adds and moves", async () => {
		for (let i = 0; i < 15; i++) assert.equal((await memoryRoute.POST(json("POST", { kind: "preference", level: "profile", text: `p${i}` }))).status, 200);
		assert.equal((await memoryRoute.POST(json("POST", { kind: "preference", level: "profile", text: "p16" }))).status, 400);
		const sub = (await (await memoryRoute.POST(json("POST", { kind: "preference", level: "subject", subject: "Maths", newSubject: true, text: "s" }))).json()) as { id: string };
		assert.equal((await memoryIdRoute.PUT(json("PUT", { move: { level: "profile" } }), params(sub.id))).status, 400);
		assert.equal(readMemoryView().profile.length, 15);
	});

	it("rename a subject and an area, edit a description; renames onto existing names are refused", async () => {
		for (const body of [
			{ kind: "preference", level: "area", subject: "Physics", newSubject: true, area: "Waves", newAreaDescription: "d1", text: "a" },
			{ kind: "preference", level: "area", subject: "Physics", area: "Optics", newAreaDescription: "d2", text: "b" },
			{ kind: "preference", level: "subject", subject: "Maths", newSubject: true, text: "c" },
		]) assert.equal((await memoryRoute.POST(json("POST", body))).status, 200);
		const put = (body: unknown) => areasRoute.PUT(json("PUT", body));
		assert.equal((await put({ subject: "Physics", newName: "maths" })).status, 400);
		assert.equal((await put({ subject: "Physics", area: "Waves", newName: "optics" })).status, 400);
		assert.equal((await put({ subject: "Physics", area: "Waves", newName: "Wave motion", description: "Standing waves" })).status, 200);
		assert.equal((await put({ subject: "Physics", newName: "Physics HL" })).status, 200);
		assert.deepEqual(memoryStore.read().areas, { "Physics HL": { "Wave motion": "Standing waves", Optics: "d2" } });
		assert.deepEqual(readMemoryView().subjects.map((s) => s.name), ["Maths", "Physics HL"]);
	});

	it("an unreadable memory.json: writes are 503, GET reports the error, nothing is overwritten", async () => {
		const file = path.join(TMP, "memory", "memory.json");
		fs.writeFileSync(file, "{broken");
		assert.equal((await memoryRoute.POST(json("POST", { kind: "preference", level: "profile", text: "x" }))).status, 503);
		const view = (await (await memoryRoute.GET()).json()) as { error?: string };
		assert.match(view.error ?? "", /corrupt/);
		assert.equal(fs.readFileSync(file, "utf-8"), "{broken");
	});
});
