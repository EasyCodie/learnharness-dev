import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concludedByDismissalPair, type LhMessage } from "../src/core/native-messages.ts";
import { undoableTail } from "../src/core/prompt-undo.ts";

const user = (id: string, content: string) => ({ id, role: "user", content, timestamp: 1 }) as LhMessage;
const reply = (id: string, stopReason: string, calls: string[] = []) => ({
	id, role: "assistant", timestamp: 1, stopReason, api: "faux", provider: "p", model: "m",
	content: [{ type: "text", text: "partial" }, ...calls.map((name, i) => ({ type: "toolCall", id: `${id}-c${i}`, name, arguments: {} }))],
}) as unknown as LhMessage;
const result = (id: string, toolName: string) => ({ id, role: "toolResult", toolCallId: `${id}-call`, toolName, content: [], isError: false, timestamp: 1 }) as unknown as LhMessage;

describe("undoableTail (Undo / Edit eligibility)", () => {
	it("offers the last typed prompt after a finished, aborted or failed turn", () => {
		for (const stop of ["stop", "aborted", "error"]) {
			assert.deepEqual(undoableTail([user("u0", "hi"), reply("a0", "stop"), user("u1", "explain x"), reply("a1", stop)]), { promptId: "u1", text: "explain x", cutAt: 2 });
		}
	});

	it("offers only the LAST prompt: an earlier one is never undoable", () => {
		const record = [user("u1", "first"), reply("a1", "stop"), user("u2", "second"), reply("a2", "stop")];
		assert.equal(undoableTail(record)?.promptId, "u2");
		assert.equal(undoableTail([...record, { id: "c", role: "custom", customType: "plan-block", content: "", display: true, details: {}, timestamp: 1 } as LhMessage]), null);
	});

	it("walks over side-effect-free tool steps", () => {
		const tail = undoableTail([user("u1", "find it"), reply("a1", "toolUse", ["grep"]), result("r1", "grep"), reply("a2", "aborted")]);
		assert.equal(tail?.promptId, "u1");
	});

	it("walks over the memory tools: Undo reverses their effects itself", () => {
		const tail = undoableTail([user("u1", "remember I like diagrams"), reply("a1", "toolUse", ["memory_subject", "remember"]), result("r1", "memory_subject"), result("r2", "remember"), reply("a2", "stop")]);
		assert.equal(tail?.promptId, "u1");
	});

	it("offers it after a normal reply delivered through send_to_user (Claude Code runtime)", () => {
		const tail = undoableTail([user("u1", "what security measures do you have"), reply("a1", "toolUse", ["send_to_user"]), result("r1", "send_to_user"), reply("a2", "stop")]);
		assert.equal(tail?.promptId, "u1");
	});

	it("refuses when the cut-off turn used a tool with side effects", () => {
		for (const tool of ["research", "plan_init", "quiz", "write_svg", "conclude"]) {
			assert.equal(undoableTail([user("u1", "go"), reply("a1", "toolUse", [tool]), result("r1", tool), reply("a2", "aborted")]), null, tool);
			assert.equal(undoableTail([user("u1", "go"), reply("a1", "aborted", [tool])]), null, `${tool} call in the cut-off reply`);
		}
	});

	it("refuses non-typed inputs and anything a compaction or marker follows", () => {
		const compaction = { id: "c", role: "custom", customType: "compaction", content: "", display: true, details: {}, timestamp: 1 } as LhMessage;
		assert.equal(undoableTail([user("u1", "x"), compaction, reply("a1", "aborted")]), null);
		assert.equal(undoableTail([{ ...user("u1", "x"), content: [{ type: "text", text: "x" }] } as LhMessage, reply("a1", "aborted")]), null);
		assert.equal(undoableTail([reply("a1", "aborted")]), null);
	});

	it("takes back the synthetic dismissal pair that rode in with the prompt", () => {
		const pair = concludedByDismissalPair("prob1");
		const tail = undoableTail([user("u0", "hi"), ...pair, user("u1", "next please"), reply("a1", "error")]);
		assert.equal(tail?.cutAt, 1);
	});
});

import { withRestoredPrompt } from "../components/prompt-edit.tsx";

describe("withRestoredPrompt (Undo into the composer)", () => {
	it("puts the prompt first and keeps a draft typed since", () => {
		assert.equal(withRestoredPrompt("old prompt", ""), "old prompt");
		assert.equal(withRestoredPrompt("old prompt", "  new draft \n"), "old prompt\n\nnew draft");
	});
});
