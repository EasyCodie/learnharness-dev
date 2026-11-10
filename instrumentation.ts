/** Next.js server start hook: prewarm the compute engine so the first check doesn't wait on Pyodide. */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV === "test") return;
	// The store directly, not src/server/stores.ts: that module syncs the custom provider at import.
	const { settingsStore } = await import("./src/store/settings.ts");
	if (settingsStore.readSettings()?.agent?.tools?.compute === false) return;
	(await import("./src/agent/compute/index.ts")).warmCompute(); // starts the process; loading is not awaited
}
