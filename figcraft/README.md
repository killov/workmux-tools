# FigCraft — WorkMux plugin

[FigCraft](https://getartcraft.com/apps/figcraft) is an open-source interface design and prototyping tool written in
Rust, one of the [ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/figcraft)).
This plugin runs its headless engine (`figcraft-cli mcp`) in a container and exposes it to WorkMux bots as a streamable
HTTP MCP server. Bots see the tools as `figcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Design app and web screens: frames, auto layout, rectangles, ellipses, vectors, text, components and instances,
styles, variables and prototype links; open `.figcraft` projects, FigCraft or REST API file JSON, `.fig` and `.sketch`
files (best effort, with `warnings` for what was not imported), SVG (becomes vectors) and images (become image layers);
export PNG, JPEG, WebP, SVG, PDF and Android Vector Drawable XML, and save `.figcraft` projects (`.fig` as an
experimental export). All files live in `/work`, the container's working directory; results are handed to the user
with `plugin_download_file`.

Tools (from `figcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `open_file`, `save_file` | open a design from `/work`, save the project as `.figcraft` (or an experimental `.fig` copy) |
| `create_node` | create a frame, shape, text, vector, section, component or slice, with properties and a `parent` |
| `set_properties` | fills, strokes, corner radius, effects, auto layout, sizing, constraints, text and font of layers |
| `inspect_document`, `get_node`, `select` | the layer tree as JSON, one layer, the selection |
| `list_commands`, `run_command`, `batch` | find engine commands by `filter` (align, component, style, variable, proto, …) and run them |
| `undo`, `redo` | one command or batch at a time |
| `screenshot` | PNG of layers or the page, saved into `/work` (the path is returned) |
| `export` | PNG/JPEG/WebP/SVG/PDF/XML of layers, or the whole file as `.fig`, into `/work` |

Typical session ("design a login screen of a mobile app, return a PNG"):

1. `figcraft__create_node {"type": "frame", "name": "Login", "width": 390, "height": 844, "props": {"fill": "#FFFFFF",
   "layout": "vertical", "gap": 16, "padding": 24}}` → frame `2`.
2. `figcraft__create_node {"type": "text", "parent": 2, "text": "Sign in", "props": {"fontSize": 28}}`, two inputs
   `{"type": "rectangle", "parent": 2, "width": 342, "height": 48, "props": {"fill": "#F2F2F2", "cornerRadius": 8}}`
   and a button with `"fill": "#3366FF"`, each with its text.
3. `figcraft__screenshot {"ids": [2]}` to check it, then
   `figcraft__export {"ids": [2], "path": "/work/login.png", "scale": 2}` → a 780×1688 PNG, and
   `plugin_download_file`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One FigCraft process per MCP session.** `initialize` starts `figcraft-cli mcp --automation-read-root /work
  --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the
  session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session has no open document — the instructions tell the bot to save the project after each
  stage.
- **tools/list, tools/call and resources are forwarded** to FigCraft (its own tool list and server instructions,
  with a WorkMux note on top). Not listed: `inspect_ui` and `wait_for_changes`, which only report on an attached
  desktop app and do nothing headless, and the canvas gestures `pointer`, `key` and `type_text` — `create_node`,
  `set_properties` (`characters` for text) and `run_command` do the same without mouse coordinates and editing
  state.
- **Paths stay in `/work`.** Top-level `path`-like arguments of every tool are resolved against `/work` and refused
  outside it (symlinks included); absolute file paths inside `run_command` params and `batch` steps are checked too.
  FigCraft's own automation roots (`/work` only) stay on as a second fence.
- **No inline files.** The PNG of `screenshot`, an `export` to PNG/JPEG/WebP without a `path` and the base64 `data`
  of a PDF or `.fig` `export` without a `path` (`"base64Keys": ["data"]` in `craft.json`) are saved into `/work` and
  replaced by their path. An SVG or XML `export` without a `path` still answers the markup as text, so the
  instructions tell the bot to always pass a `path`.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Rendering runs on the CPU, so no GPU is needed; the fonts (Inter and others) are built into the engine. The preloaded
`meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

FigCraft **0.18.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `figcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `figcraft-cli` | the FigCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a FigCraft process |
| `SESSION_IDLE_MINUTES` | `60` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | FigCraft processes at once; the least recently used is closed beyond it |
| `FIGCRAFT_*` | — | passed to `figcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-figcraft figcraft
docker run --rm -p 8080:8080 workmux-plugin-figcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). FigCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/figcraft`.
