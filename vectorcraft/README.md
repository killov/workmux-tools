# VectorCraft — WorkMux plugin

[VectorCraft](https://getartcraft.com/apps/vectorcraft) is an open-source vector illustration app written in Rust,
one of the [ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/vectorcraft)).
This plugin runs its headless engine (`vectorcraft-cli mcp`) in a container and exposes it to WorkMux bots as a
streamable HTTP MCP server. Bots see the tools as `vectorcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Open vector documents (SVG/SVGZ, PDF, Illustrator `.ai`, EPS, DXF, `.vectorcraft`; PNG/JPEG as an image to trace or
draw over) or start a blank artboard, draw shapes, Bézier paths and type, set fills, strokes and gradients, apply
live effects, Pathfinder and transforms, run any menu command of the desktop app, render PNG previews and export SVG,
PDF, PNG, JPEG, WebP, EPS, AI, DXF and more. Type renders with the fonts bundled in the engine, so no system fonts
are needed. All files live in `/work`, the container's working directory; results are handed to the user with
`plugin_download_file`.

Tools (from `vectorcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `open_file`, `save_file` | open a file from `/work` as a new document; save `.vectorcraft`, SVG, PDF, AI or EPS |
| `export` | export the document, an artboard or the selection into `/work` (the extension picks the format) |
| `draw_shape`, `draw_path`, `add_text` | rectangles, ellipses, polygons, stars and lines; paths from points or SVG `d`; point, area and path type |
| `set_paint`, `apply_effect`, `pathfinder`, `transform`, `text_wrap` | paint, live effects, shape combinations, move/rotate/scale/reflect/shear, text wrap |
| `create_graph` | column, bar, line, area, scatter, pie and radar graphs from CSV or series |
| `command_list` / `list_commands` | find engine commands by `filter`, with their parameter docs |
| `command_run` / `run_command`, `command_batch` | run one or several engine commands (every menu action, e.g. `file.new`) |
| `doc_inspect` / `inspect_document` | artboards, layer tree, object ids, selection, history |
| `render_preview`, `screenshot` | PNG of an artboard, saved into `/work` (the path is returned) |
| `undo`, `redo`, `select_tool`, `pointer_gesture`, `press_key` | history and tool-driven editing as with the mouse and keyboard |

Typical session ("draw a simple coffee shop logo, return SVG and PNG"):

1. `vectorcraft__command_run {"id": "file.new", "params": {"width": 512, "height": 512}}`.
2. `vectorcraft__draw_shape {"shape": "ellipse", "x": 96, "y": 96, "width": 320, "height": 320, "fill": "#6f4e37", "stroke": "none"}`.
3. `vectorcraft__draw_shape {"shape": "rectangle", "x": 176, "y": 200, "width": 160, "height": 120, "radius": 16, "fill": "#ffffff", "stroke": "none"}`.
4. `vectorcraft__draw_path {"d": "M236 180 C226 160 246 150 236 130", "stroke": "#ffffff", "strokeWidth": 6, "fill": "none"}`.
5. `vectorcraft__add_text {"text": "CAFE", "x": 256, "y": 400, "justify": "center", "size": 48, "color": "#ffffff"}`.
6. `vectorcraft__render_preview {}` → `/work/render_preview-<time>.png`.
7. `vectorcraft__export {"path": "/work/cafe-logo.svg", "outlineText": true}` and
   `vectorcraft__export {"path": "/work/cafe-logo.png"}`, then `plugin_download_file`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One VectorCraft process per MCP session.** `initialize` starts `vectorcraft-cli mcp --automation-read-root /work
  --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the
  session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session has a blank document only — the instructions tell the bot to save `.vectorcraft`
  files.
- **tools/list, tools/call and resources are forwarded** to VectorCraft (its own tool list and server instructions,
  with a WorkMux note on top). The tools that need the desktop app (`ui_*`, `inspect_ui`, `type_text`,
  `answer_dialog`, `open_panel`, `invoke_menu`) are not listed.
- **Paths stay in `/work`.** Top-level `path`-like arguments of every tool are resolved against `/work` and refused
  outside it (symlinks included); absolute file paths inside `command_run` params and `command_batch` steps are
  checked too. VectorCraft's own automation roots (`/work` only) stay on as a second fence.
- **No inline files.** The PNG of `render_preview` and `screenshot` is saved into `/work` and replaced by its path;
  an export without a destination (`dataBase64` in the answer) is written into `/work` and answered with its `path`.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Rendering uses VectorCraft's CPU renderer, so no GPU is needed. The preloaded `meminfo.c` shim caps `MemTotal` in
`/proc/meminfo` by the container's memory limit ([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

VectorCraft **0.24.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the
generated `Dockerfile` carries them as `ARG` defaults. Only `vectorcraft-cli` and its licence files are extracted
from the package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version`
and both checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run
`node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `vectorcraft-cli` | the VectorCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a VectorCraft process |
| `SESSION_IDLE_MINUTES` | `60` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | VectorCraft processes at once; the least recently used is closed beyond it |
| `VECTORCRAFT_*` | — | passed to `vectorcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-vectorcraft vectorcraft
docker run --rm -p 8080:8080 workmux-plugin-vectorcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). VectorCraft itself is MIT/Apache-2.0; its licence files, and
those of the bundled fonts, are in the image under `/usr/share/doc/vectorcraft`.
