/**
 * The compute tool (docs/superpowers plan, 2026-11-09): Pyodide + SymPy in a
 * permission-restricted child process. Results, the error path, the timeout
 * kill/respawn, job ordering, and the sandbox escape attempts that gate it.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { runCompute } from "../src/agent/compute/index.ts";
import { computeTool } from "../src/agent/tools/compute.ts";
import { toolTimeoutMs } from "../src/agent/tool-execute.ts";

const exec = (code: string) => computeTool.execute("call-1", { code }, undefined);
const text = (r: Awaited<ReturnType<typeof exec>>) => (r.content[0] as { text: string }).text;
// JS reached from Python through any proxy's Function constructor — the escape the sandbox must contain.
const viaJs = (js: string) => `import js\njs.constructor.constructor(${JSON.stringify(js)})()`;

describe("compute tool", { timeout: 60_000 }, () => {
	after(() => { toolTimeoutMs.current = 30_000; });

	it("returns exact SymPy results and printed output", async () => {
		assert.equal(text(await exec("x = Symbol('x')\nintegrate(x**2, (x, 0, 3))")), "9");
		assert.equal(text(await exec("Rational(1,3) + Rational(1,6)")), "1/2");
		assert.equal(text(await exec("print('a')\nprint('b')")), "a\nb\n");
	});

	it("rejects with the traceback tail on syntax and runtime errors", async () => {
		await assert.rejects(exec("def ("), /SyntaxError/);
		await assert.rejects(exec("1/0"), /ZeroDivisionError: division by zero/);
	});

	it("keeps no state between calls", async () => {
		await exec("leak = 42");
		await assert.rejects(exec("leak"), /NameError/);
	});

	it("kills a runaway job on timeout and the next call respawns", async () => {
		await exec("1"); // warm, so the timeout covers only the loop
		toolTimeoutMs.current = 1_500;
		await assert.rejects(exec("while True: pass"), /timed out|stopped/);
		toolTimeoutMs.current = 30_000;
		assert.equal(text(await exec("2 + 2")), "4");
	});

	it("runs concurrent jobs one at a time, in order", async () => {
		const order: string[] = [];
		await Promise.all([
			runCompute("sum(range(2_000_000))").then(() => order.push("first")),
			runCompute("1").then(() => order.push("second")),
		]);
		assert.deepEqual(order, ["first", "second"]);
	});

	it("an aborted queued job leaves the running job alone", async () => {
		const controller = new AbortController();
		const running = runCompute("sum(range(2_000_000))");
		const queued = runCompute("1", controller.signal);
		controller.abort();
		assert.equal(await running, "1999999000000");
		await assert.rejects(queued, /before it started/);
		assert.equal(await runCompute("3"), "3", "the engine survived");
	});

	it("blocks sandbox escapes", async () => {
		const blocked = [
			viaJs("return process.getBuiltinModule('fs').readFileSync('/etc/hosts', 'utf8')"),
			viaJs("return process.getBuiltinModule('fs').writeFileSync('/tmp/lh-compute-escape', 'x')"),
			viaJs("return String(process.getBuiltinModule('child_process').execSync('echo hi'))"),
			viaJs("return process.getBuiltinModule('module').createRequire('/x')('node:https')"),
			viaJs("return process.getBuiltinModule('net').connect(443, 'example.com')"),
			viaJs("return fetch('https://example.com')"),
			"open('/etc/hosts').read()",
			"import pyodide_js\npyodide_js.FS.mkdir('/h')\npyodide_js.FS.mount(pyodide_js.FS.filesystems.NODEFS, {'root': '/'}, '/h')\npyodide_js.FS.readdir('/h')",
		];
		for (const code of blocked) await assert.rejects(exec(code), Error, code);
		// macOS injects __CF_USER_TEXT_ENCODING into every process; nothing else may arrive.
		assert.equal(text(await exec(viaJs("return Object.keys(process.env).filter(k => !['ELECTRON_RUN_AS_NODE', '__CF_USER_TEXT_ENCODING'].includes(k)).join()"))), "''", "no env reaches the sandbox");
		// Dynamic import settles asynchronously; JS globals outlive the call, so read the outcome on the next one.
		await exec(viaJs("globalThis.probe = 'pending'; import('node:net').then(() => { globalThis.probe = 'loaded' }, () => { globalThis.probe = 'blocked' })"));
		assert.equal(text(await exec(viaJs("return globalThis.probe"))), "'blocked'");
	});
});
