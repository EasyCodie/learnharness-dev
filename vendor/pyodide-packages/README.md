# Vendored Pyodide packages

Offline wheels for the `compute` tool (`src/agent/compute/`). They must match the pinned `pyodide` version in `package.json`; re-vendor on every Pyodide bump from that version's `pyodide-lock.json`.

Pyodide 314.0.7, source `https://cdn.jsdelivr.net/pyodide/v314.0.7/full/<file>`:

| File | SHA-256 (matches pyodide-lock.json) |
|---|---|
| `sympy-1.14.0-py3-none-any.whl` | `61ea8bb98049ba1c702ba3ad2607acb7ab94b9af0b6f97498741f50d3249f428` |
| `mpmath-1.4.1-py3-none-any.whl` | `e5ebd537e74b9066341a5152e83b63ff2fc37a6388fa7351e766b6e4640f7eee` |
