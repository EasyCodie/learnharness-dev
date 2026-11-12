/** Next.js server start hook: initialize plugins, then prewarm the compute engine
 * so the first check doesn't wait on Pyodide. A plugin failure must not prevent
 * access to existing learning data or teaching/practice. */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { initializePlugins } = await import("./src/server/plugins.ts");
	try { await initializePlugins(); }
	catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
	if (process.env.NODE_ENV === "test") return;
	// The store directly, not src/server/stores.ts: that module syncs the custom provider at import.
	const { settingsStore } = await import("./src/store/settings.ts");
	if (settingsStore.readSettings()?.agent?.tools?.compute === false) return;
	(await import("./src/agent/compute/index.ts")).warmCompute(); // starts the process; loading is not awaited
}
