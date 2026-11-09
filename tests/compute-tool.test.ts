/**
 * The compute tool (docs/superpowers plan, 2026-11-09): Pyodide + SymPy in a
 * permission-restricted child process. Results, the error path, the timeout
 * kill/respawn, job ordering, and the sandbox escape attempts that gate it.
 */
import assert from "node:assert/strict";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { after, describe, it } from "node:test";
import { runCompute } from "../src/agent/compute/index.ts";
import { computeTool } from "../src/agent/tools/compute.ts";
import { toolTimeoutMs } from "../src/agent/tool-execute.ts";

export const engineState = () => (globalThis as { __lhCompute?: { engine: { child: ChildProcessWithoutNullStreams } | null } }).__lhCompute!;
export async function stopEngine(): Promise<void> {
	const eng = engineState()?.engine;
	if (!eng) return;
	await new Promise<void>((resolve) => {
		eng.child.once("exit", () => resolve());
		eng.child.kill("SIGKILL");
	});
}

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
		const lockdown = [
			viaJs("return typeof process.getBuiltinModule('_http_client').ClientRequest"),
			viaJs("return typeof process.getBuiltinModule('_tls_wrap').connect"),
			viaJs("return typeof process.getBuiltinModule('node:_http_agent').Agent"),
			viaJs("return typeof process.getBuiltinModule('module').registerHooks"),
			viaJs("const s = new (process.stdout.constructor)(); s.on('error', () => {}); s.connect(9, '127.0.0.1'); return 'connected'"),
			viaJs("const s = new (process.stdin.constructor)(); s.on('error', () => {}); s.connect(9, '127.0.0.1'); return 'connected'"),
		];
		for (const code of lockdown) await assert.rejects(exec(code), /disabled in compute/, code);
		// macOS injects __CF_USER_TEXT_ENCODING into every process; nothing else may arrive.
		assert.equal(text(await exec(viaJs("return Object.keys(process.env).filter(k => !['ELECTRON_RUN_AS_NODE', '__CF_USER_TEXT_ENCODING'].includes(k)).join()"))), "''", "no env reaches the sandbox");
		// Dynamic import settles asynchronously; JS globals outlive the call, so read the outcome on the next one.
		await exec(viaJs("globalThis.probe = 'pending'; import('node:net').then(() => { globalThis.probe = 'loaded' }, () => { globalThis.probe = 'blocked' })"));
		assert.equal(text(await exec(viaJs("return globalThis.probe"))), "'blocked'");
		await exec(viaJs("globalThis.probe = 'pending'; import('node:_http_client').then(() => { globalThis.probe = 'loaded' }, () => { globalThis.probe = 'blocked' })"));
		assert.equal(text(await exec(viaJs("return globalThis.probe"))), "'blocked'");
	});

	it("still runs common SymPy checks after lockdown", async () => {
		assert.equal(text(await exec("x = Symbol('x')\nsolve(x**2 - 4, x)")), "[-2, 2]");
		assert.equal(text(await exec("x = Symbol('x')\nlimit(sin(x)/x, x, 0)")), "1");
		assert.equal(text(await exec("Matrix([[2, 0], [0, 3]]).eigenvals()")), "{2: 1, 3: 1}");
		assert.equal(text(await exec("x = Symbol('x')\nseries(exp(x), x, 0, 3)")), "1 + x + x**2/2 + O(x**3)");
		assert.equal(text(await exec("nsimplify(0.333333333333333)")), "1/3");
	});

	it("a failed write to the engine rejects the call and the next call respawns", async () => {
		await runCompute("1");
		engineState().engine!.child.stdin.destroy();
		await assert.rejects(runCompute("2"), /compute engine (failed|stopped)/);
		assert.equal(await runCompute("3"), "3");
	});

	it("a spawn failure rejects the call", async () => {
		await stopEngine();
		const execPath = process.execPath;
		process.execPath = "/nonexistent/lh-node";
		try { await assert.rejects(runCompute("1"), /compute engine failed.*ENOENT/); }
		finally { process.execPath = execPath; }
		assert.equal(await runCompute("1"), "1");
	});

	it("output without a trailing newline stays with its own job", async () => {
		assert.equal(await runCompute("print(9, end='')"), "9\n");
		assert.equal(await runCompute("print('1/2')"), "1/2\n");
	});
});
