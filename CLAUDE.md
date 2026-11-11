# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

Node 26 (matches CI).

```sh
npm run dev              # Next dev server, http://localhost:3000
npm run desktop:dev      # Next dev + Electron
npm test                 # all tests: node:test via tsx, fake providers, no keys needed
NODE_ENV=test npx tsx --test tests/chat-flow.test.ts   # one test file (tests/path-input.test.tsx also needs --experimental-test-module-mocks)
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint, including the layer import rules
npm run build            # Next production build (standalone output)
```

CI runs `typecheck`, `test`, `lint`, then a separate standalone job: the native renderer tests under Electron (`npx electron --import tsx --test tests/pdf-native-render.test.ts ...` with `ELECTRON_RUN_AS_NODE=1 NODE_ENV=test`), `build`, and `scripts/smoke-provider-runtime.mjs`. Other `scripts/smoke-*.mjs` have prerequisites; read the script and `docs/development.md#checks` before running one. `npm run desktop:dist` is the signed macOS release path, not a quick local build.

## Keeping tool output small

- Tests: run with `NODE_OPTIONS=--test-reporter=dot` (e.g. `NODE_OPTIONS=--test-reporter=dot npm test`). It prints dots plus full detail for failures only, about 5 KB instead of 530 KB for the full suite. Use the default reporter only when you need per-test names, piped through `grep -E '✖|fail'`.
- `typecheck`, `lint`, `build`: pipe through `| tail -40` (or `| grep -E 'error|warning' | head -40`), and rerun narrower if that isn't enough.
- Never `cat` a source or log file: `grep -n` to find the lines, then Read with offset/limit. Cap `find`, `grep -r` and `git log` with `| head -50`; run `git diff --stat` first, then diff one file at a time.
- Many files are 40–120 KB (`components/chat.tsx`, `components/graph-view.tsx`, `src/agent/subagents/extraction.ts`, the large `tests/*.test.ts`). Find the symbol with `grep -n`, then read only that range (~150 lines). Don't re-read a file that hasn't changed.

## Architecture

Next.js app with an Electron host. The server owns agent runs, conversation records, background workers, and filesystem persistence; the browser projects those records into the lesson/practice UI and knowledge graph. Agents run on the Pi agent runtime (`@earendil-works/pi-agent-core`, `pi-ai`).

Layers, enforced by `import/no-restricted-paths` in `eslint.config.mjs`:

- `app/` pages and HTTP routes; `components/` browser state and UI. Both import `src/` only through the core/server barrels.
- `src/server/` composition and HTTP-facing services (`chat-handler.ts`, `jobs.ts`, `stores.ts`).
- `src/agent/` agent construction, tools, provider streams, background subagents (`teacher-agent.ts`, `models.ts`, `tools.ts`, `subagents/`). Must not import server or store.
- `src/core/` contracts, record→view projections, domain algorithms. Must not import IO layers; dependencies arrive through injected contexts/ports.
- `src/store/` filesystem adapters (chats, jobs, graph, settings, credentials).
- `electron/` CommonJS desktop host; `scripts/` and `tests/` are unrestricted.

A turn: `POST /api/chat` saves the input, then `chat-handler.ts` builds a fresh Pi `Agent` from the saved `ChatRecord` and claims per-chat liveness (a competing turn gets 409). Output streams through `GET /api/chats/:id/stream`. System prompts are composed from segments; see `src/agent/prompts/README.md`.

Read `docs/architecture.md` before changing turn flow, background work, the graph, storage formats, or provider/file-access code; it is the reference for those boundaries. `docs/teaching-methodology.md` holds the pedagogical intent behind the agent prompts.

## Working safely

- `data/` (gitignored) is the live development profile with real learning records, and `auth.json` / `*-credentials.json` at the repo root hold real keys. For reproduction, point the server at scratch files: `LH_DATA_DIR=/abs/scratch/data LH_AUTH_FILE=/abs/scratch/auth.json npm run dev -- --port 3001`.
- Golden fixtures (`tests/fixtures/golden-data/`) exercise saved records through production paths; change their expectations only with an intentional format change, never to make a test pass.
- Debug flags (`LH_PROVIDER_EVENTS`, `LH_BACKGROUND_CAPTURE`) are in `docs/development.md#debugging`; they must reach the Next server, so restart it after setting one.
- Discuss changes to teaching methodology, agent behavior, core architecture, storage formats, or new features with the user before implementing (CONTRIBUTING.md).
