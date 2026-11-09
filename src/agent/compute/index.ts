import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * The compute engine's host side: one warm sandboxed child process per server
 * process (compute-worker.mjs), started lazily on the first call, jobs run one
 * at a time. Synchronous WASM can't be interrupted, so an abort or timeout of
 * the running job kills the process; the next call respawns it.
 */

const OUTPUT_CAP = 4000;

type Reply = { id: number; ok: boolean; text: string };
interface Engine {
	child: ChildProcessWithoutNullStreams;
	pending: Map<number, (reply: Reply) => void>;
}

// On globalThis so dev hot reloads reuse the process instead of orphaning it.
const state = ((globalThis as { __lhCompute?: { engine: Engine | null; tail: Promise<unknown>; nextId: number } }).__lhCompute ??= {
	engine: null,
	tail: Promise.resolve(),
	nextId: 0,
});

function startEngine(): Engine {
	// cwd-relative like the image workers: the packaged server's cwd is the standalone root.
	const root = process.cwd();
	const pyodideDir = path.join(root, "node_modules/pyodide") + path.sep;
	const wheelDir = path.join(root, "vendor/pyodide-packages") + path.sep;
	const worker = path.join(root, "src/agent/compute/compute-worker.mjs");
	const child = spawn(
		process.execPath,
		["--permission", `--allow-fs-read=${pyodideDir}`, `--allow-fs-read=${wheelDir}`, `--allow-fs-read=${worker}`, worker, pyodideDir, wheelDir],
		// Empty env: no keys reach the sandbox. Electron's binary still needs its run-as-node switch.
		{ env: (process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: "1" } : {}) as NodeJS.ProcessEnv, stdio: "pipe" },
	);
	const engine: Engine = { child, pending: new Map() };
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
	createInterface({ input: child.stdout }).on("line", (line) => {
		let reply: Reply;
		try { reply = JSON.parse(line); } catch { return; }
		engine.pending.get(reply.id)?.(reply);
		engine.pending.delete(reply.id);
	});
	let stopped = false;
	const stop = (text: string): void => {
		if (stopped) return;
		stopped = true;
		if (state.engine === engine) state.engine = null;
		for (const settle of engine.pending.values()) settle({ id: -1, ok: false, text });
		engine.pending.clear();
		try {
			if (child.pid) child.kill("SIGKILL");
		} catch {}
	};
	child.on("exit", (code, signal) => {
		stop(`The compute engine stopped (code ${code ?? "none"}, signal ${signal ?? "none"}).${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
	});
	child.on("error", (error) => stop(`The compute engine failed (${error.message}).`));
	child.stdin.on("error", (error) => stop(`The compute engine failed (${error.message}).`));
	hold(engine, false);
	return engine;
}

/** An idle warm engine must not keep the host process (server, test run) alive. */
function hold(engine: Engine, busy: boolean): void {
	for (const handle of [engine.child, engine.child.stdin, engine.child.stdout, engine.child.stderr] as Array<{ ref?(): void; unref?(): void }>) {
		if (busy) handle.ref?.();
		else handle.unref?.();
	}
}

function cap(text: string): string {
	return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n[output truncated at ${OUTPUT_CAP} characters]` : text;
}

function execute(code: string, signal?: AbortSignal): Promise<string> {
	// A job aborted while queued never touches the engine.
	if (signal?.aborted) return Promise.reject(new Error("The computation was stopped before it started."));
	const engine = (state.engine ??= startEngine());
	const id = ++state.nextId;
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			engine.pending.delete(id);
			// Detach before the exit event so the next call can't reuse the dying process.
			if (state.engine === engine) state.engine = null;
			engine.child.kill("SIGKILL");
			reject(new Error("The computation was stopped (timed out or aborted); the engine was restarted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		hold(engine, true);
		engine.pending.set(id, (reply) => {
			signal?.removeEventListener("abort", onAbort);
			if (engine.pending.size <= 1) hold(engine, false);
			if (reply.ok) resolve(cap(reply.text) || "(no output: end with an expression or print() to see a value)");
			else reject(new Error(cap(reply.text)));
		});
		engine.child.stdin.write(`${JSON.stringify({ id, code })}\n`);
	});
}

/** Run Python (SymPy preloaded) in the sandbox. Resolves with printed output
 *  plus the final expression's repr; rejects with the traceback tail. */
export function runCompute(code: string, signal?: AbortSignal): Promise<string> {
	const result = state.tail.then(() => execute(code, signal));
	state.tail = result.catch(() => undefined);
	return result;
}
