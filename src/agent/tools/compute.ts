import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { runCompute } from "../compute/index.ts";

/**
 * The compute tool: answer-key checks in sandboxed Python + SymPy (Pyodide in
 * a permission-restricted child process — compute/index.ts). Toggleable, on
 * by default; its usage doctrine lives in the description, so it reaches the
 * model only when the tool does. Errors throw: pi turns the throw into an
 * isError tool result the model can fix and retry from.
 */

const computeInput = Type.Object({
	code: Type.String({
		minLength: 1,
		description: "Python source. SymPy is preloaded (from sympy import *). Returns printed output plus the value of a final bare expression.",
	}),
});

/** The same rule, stated where answer keys are written (the question and
 *  problem tool descriptions): the model reads those while authoring a key. */
export const CHECK_KEY_FIRST =
	"If the answer key depends on a calculation, even a trivial one, and you have the compute tool, call compute to check it before this call. ";

export const computeTool: AgentTool<typeof computeInput> = {
	name: "compute",
	label: "compute",
	description:
		"Run Python with SymPy preloaded (`from sympy import *`) in an offline sandbox and get back printed output plus the last expression's value. " +
		"Use it to check calculations, not to think: work the problem yourself, then check the result. " +
		"REQUIRED before committing any answer key that depends on a calculation, even when the calculation looks trivial — a quiz or recall `correctAnswer`, or a practice `modelSolution` " +
		"(integrals, derivatives, algebra, exact arithmetic, probabilities, matrix work, an algorithm's trace). " +
		"Put every check for one question in a single call. Each call starts fresh: variables and common settings (precision, evaluation, recursion limit) reset between calls. " +
		"The learner never sees the code or the result. If the check disagrees with your answer, find out which is wrong before committing.",
	parameters: computeInput,
	// One engine process runs one job at a time; never overlap calls.
	executionMode: "sequential",
	execute: serverExecute("compute", computeInput, ({ code }, { signal }) => runCompute(code, signal)),
};
