/**
 * The settled compute call: a fixed one-liner in every state. It never reads
 * the part's input, output or errorText — the code, its result and any
 * traceback can all contain the answer key the model was checking.
 */
export function ComputeCard() {
	return (
		<div data-testid="compute-card" className="my-1 w-full max-w-2xl select-none text-xs text-muted-foreground">
			Checked a calculation
		</div>
	);
}
