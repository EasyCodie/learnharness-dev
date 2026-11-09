/**
 * The compute tool (docs/superpowers plan, 2026-11-09): Pyodide + SymPy in a
 * permission-restricted child process. Results, the error path, the timeout
 * kill/respawn, job ordering, and the sandbox escape attempts that gate it.
 */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { after, describe, it } from "node:test";
import { runCompute, warmCompute } from "../src/agent/compute/index.ts";
import { computeTool } from "../src/agent/tools/compute.ts";
import { toolTimeoutMs } from "../src/agent/tool-execute.ts";

const engineState = () => (globalThis as { __lhCompute?: { engine: { child: ChildProcessWithoutNullStreams } | null } }).__lhCompute!;
async function stopEngine(): Promise<void> {
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
		// With an error, so the stream emits one: a bare destroy() only ends the engine, which the exit handler already covered.
		engineState().engine!.child.stdin.destroy(new Error("boom"));
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

	it("resets interpreter settings between calls", async () => {
		const read = "import sys, decimal, mpmath\nfrom sympy.core.parameters import global_parameters as g\n(sys.getrecursionlimit(), sys.get_int_max_str_digits(), decimal.getcontext().prec, mpmath.mp.dps, g.evaluate, g.distribute, g.exp_is_pow)";
		const before = await runCompute(read);
		await runCompute("import sys, decimal, mpmath, random, io\nfrom sympy.core.parameters import global_parameters as g\nsys.setrecursionlimit(50000)\nsys.set_int_max_str_digits(640)\ndecimal.getcontext().prec = 6\nmpmath.mp.dps = 6\ng.evaluate = False\ng.distribute = False\ng.exp_is_pow = True\nrandom.seed(1)\nsys.stdout = sys.stderr = io.StringIO()");
		assert.equal(await runCompute(read), before);
		const draw = await runCompute("import random\nrandom.random()");
		assert.notEqual(draw, "0.13436424411240122");
		assert.notEqual(await runCompute("import random\nrandom.random()"), draw, "calls don't replay the same numbers");
		assert.equal(await runCompute("x = Symbol('x')\nx + x"), "2*x");
		assert.equal(await runCompute("print('seen')"), "seen\n");
	});

	it("a fatal Pyodide error restarts the engine", async () => {
		await runCompute("1");
		const pid = engineState().engine!.child.pid;
		const fatal = runCompute("import pyodide_js\npyodide_js._api.fatal_error(Exception('boom'))");
		const next = runCompute("1"); // queued behind it: must not reach the dying engine
		await assert.rejects(fatal, /compute engine failed/);
		assert.equal(await next, "1");
		assert.notEqual(engineState().engine!.child.pid, pid);
	});

	it("warmCompute starts the engine the next call reuses", async () => {
		await stopEngine();
		warmCompute();
		const pid = engineState().engine!.child.pid;
		assert.equal(await runCompute("1"), "1");
		assert.equal(engineState().engine!.child.pid, pid);
	});
});
