// The compute engine: Pyodide + SymPy in a child process started under Node's
// permission model (read-only access to the Pyodide and wheel folders, no
// writes, no child processes, no workers). Protocol: one JSON line per job on
// stdin ({ id, code }), one JSON line per reply on stdout ({ id, ok, text }).
// Spawned by ./index.ts; see docs/architecture.md for the sandbox notes.
import { constants, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const [pyodideDir, wheelDir] = process.argv.slice(2);

// Pyodide's NODEFS reads fs flag constants through the legacy binding, which
// the permission model denies; every other binding stays unreachable.
process.binding = (name) => {
	if (name === "constants") return { fs: constants };
	throw new Error("process.binding is disabled");
};

const { loadPyodide } = await import(pathToFileURL(`${pyodideDir}pyodide.mjs`).href);
let printed = "";
const py = await loadPyodide({
	indexURL: pyodideDir,
	jsglobals: {},
	stdout: (line) => { printed += `${line}\n`; },
	stderr: (line) => { printed += `${line}\n`; },
});
const wheels = readdirSync(wheelDir).filter((f) => f.endsWith(".whl")).map((f) => wheelDir + f);
await py.loadPackage(wheels, { messageCallback() {}, errorCallback() {} });
py.runPython(`
import ast, decimal, json, os, random, sys, traceback
import mpmath
from sympy.core.parameters import global_parameters as _lh_params
_lh_base = {"__name__": "__main__"}
exec("from sympy import *", _lh_base)

def _lh_run(code):
    g = dict(_lh_base)  # fresh namespace per call: no state carries over
    # Settings a job may change are put back after it. sys.modules stays: dropping lazily
    # loaded SymPy submodules would duplicate classes and break isinstance.
    limits = (sys.getrecursionlimit(), sys.get_int_max_str_digits(), mpmath.mp.prec)
    context, state = decimal.getcontext().copy(), random.getstate()
    params = (_lh_params.evaluate, _lh_params.distribute, _lh_params.exp_is_pow)
    try:
        tree = ast.parse(code, "<compute>", "exec")
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        exec(compile(tree, "<compute>", "exec"), g)
        value = eval(compile(ast.Expression(last.value), "<compute>", "eval"), g) if last else None
        return json.dumps([True, "" if value is None else repr(value)])
    except BaseException:
        return json.dumps([False, "\\n".join(traceback.format_exc().splitlines()[-20:])])
    finally:
        sys.setrecursionlimit(limits[0])
        sys.set_int_max_str_digits(limits[1])
        mpmath.mp.prec = limits[2]
        decimal.setcontext(context)
        random.setstate(state)
        _lh_params.evaluate, _lh_params.distribute, _lh_params.exp_is_pow = params
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        try:  # flush() alone leaves a partial line in Pyodide's line-batched handler; fsync emits it
            os.fsync(1)
        except Exception:
            pass
        try:
            os.fsync(2)
        except Exception:
            pass
`);
const run = py.globals.get("_lh_run");

// Lock down only now: Pyodide itself imports node:vm while loading. After load,
// allow no further module loads and disable socket connect so neither Python
// proxies nor JS escapes can reach the network or host system.
const ALLOWED = new Set([]);
registerHooks({
	resolve(specifier, context, next) {
		const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
		if (!ALLOWED.has(bare)) throw new Error(`${specifier} is disabled in compute`);
		return next(specifier, context);
	},
});
const getBuiltinModule = process.getBuiltinModule.bind(process);
process.getBuiltinModule = (id) => {
	const bare = id.startsWith("node:") ? id.slice(5) : id;
	if (!ALLOWED.has(bare)) throw new Error(`${id} is disabled in compute`);
	return getBuiltinModule(id);
};
for (const stream of [process.stdout, process.stdin]) {
	for (let proto = stream; proto != null; proto = Object.getPrototypeOf(proto)) {
		if (Object.hasOwn(proto, "connect")) {
			proto.connect = () => { throw new Error("net.Socket.connect is disabled in compute"); };
		}
	}
}
process._linkedBinding = () => { throw new Error("process._linkedBinding is disabled"); };
for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) delete globalThis[name];

const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
// Jobs sent while loading wait in stdin's buffer. stdin closing (the server
// went away) ends this loop and the process.
for await (const line of createInterface({ input: process.stdin })) {
	let id = null;
	try {
		const job = JSON.parse(line);
		id = job.id;
		printed = "";
		const [ok, value] = JSON.parse(run(job.code));
		reply({ id, ok, text: ok ? printed + value : value });
	} catch (error) {
		reply({ id, ok: false, text: String(error?.message ?? error) });
	}
}
process.exit(0);
