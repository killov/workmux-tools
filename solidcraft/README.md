# SolidCraft CAD — WorkMux tool

[SolidCraft](https://solidcraft.io) is an open-source parametric 3D CAD written in Rust
([source](https://github.com/tangency-labs/solidcraft), [MCP guide](https://docs.solidcraft.io/guide/mcp.html)).
This tool runs its headless design session (`solidcraft-cli mcp --headless`) in a container and exposes it to
WorkMux bots as a streamable HTTP MCP server. Bots see the tools as `solidcraft__<tool>`.

## What a bot can do

Design parts from sketches, extrusions, primitives, holes and fillets, measure them, render PNG previews and export
STL, STEP, 3MF, OBJ, GLB or IGES — all inside `/work`, the container's working directory. Results are handed to the
user with `tool_download_file`.

Typical session:

1. `solidcraft__skill_reference {"skill": "solidcraft-modeling"}` — the modeling guide.
2. `solidcraft__new_design {"name": "bracket"}` (or `open {"path": "/work/part.step"}` for an uploaded file).
3. `solidcraft__batch {...}` / `solidcraft__execute {"command": "solid.box", "params": {"length": 40, "width": 20, "height": 10}}`.
4. `solidcraft__measure {}`, `solidcraft__screenshot {"view": "iso"}` → returns `/work/screenshot-<time>.png`.
5. `solidcraft__save {"path": "/work/bracket.sc"}`, `solidcraft__export {"path": "/work/bracket.stl"}`.
6. `tool_download_file` for `/work/bracket.stl`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One SolidCraft process per MCP session.** `initialize` starts `solidcraft-cli mcp --headless --allow-path /work
  --require-allow-path` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the session
  (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session means a new, empty design — the instructions tell the bot to save `.sc` files.
- **tools/list and tools/call are forwarded** to SolidCraft (its own tool list and server instructions, with a
  WorkMux note on top).
- **Paths stay in `/work`.** `open`, `save`, `export`, `screenshot`, `compare_picture.reference` and `batch.path`
  are resolved against `/work` and refused outside it (symlinks included); absolute file paths inside `execute` /
  `batch` params are checked too. SolidCraft's own `--allow-path` limit stays on as a second fence.
- **No inline files.** `screenshot` always writes a PNG into `/work` and returns its path; any other inline image
  (e.g. the `compare_picture` overlay) is saved into `/work` and replaced by its path.
- **Timeouts.** Each call is limited to `SOLIDCRAFT_CALL_TIMEOUT_MS` (default 300 s); startup to
  `SOLIDCRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Rendering is the CPU rasterizer (`SOLIDCRAFT_GPU=cpu`), so no GPU is needed.

## Version

SolidCraft **0.46.2**, pinned in the `Dockerfile` with the SHA-256 of the release `.deb` (amd64 and arm64). Only
`solidcraft-cli` is extracted from it; the desktop app and its GUI libraries are not installed. To update, change
`SOLIDCRAFT_VERSION` and both checksums from the release's `SHA256SUMS.txt`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `SOLIDCRAFT_CLI` | `/usr/bin/solidcraft-cli` | the SolidCraft CLI |
| `SOLIDCRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `SOLIDCRAFT_START_TIMEOUT_MS` | `30000` | start of a SolidCraft process |
| `SESSION_IDLE_MINUTES` | `60` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | SolidCraft processes at once; the least recently used is closed beyond it |
| `SOLIDCRAFT_MCP_COMPACT` | — | `1` for SolidCraft's compact tool output |

## Run locally

```sh
docker build -t workmux-tool-solidcraft solidcraft
docker run --rm -p 8080:8080 workmux-tool-solidcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). SolidCraft itself is MIT/Apache-2.0; its licence files are
in the image under `/usr/share/doc/solidcraft`.
