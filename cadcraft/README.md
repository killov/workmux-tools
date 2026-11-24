# CADCraft — WorkMux plugin

[CADCraft](https://getartcraft.com/apps/cadcraft) is an open-source 2D CAD drafting app written in Rust, with an
AutoCAD-style command line, one of the [ArtCraft](https://getartcraft.com/apps) applications
([source](https://github.com/storytold/cadcraft)). This plugin runs its headless engine (`cadcraft-cli mcp`) in a
container and exposes it to WorkMux bots as a streamable HTTP MCP server. Bots see the tools as `cadcraft__<tool>`.

CADCraft is 2D drafting (floor plans, technical drawings, DXF/DWG); for 3D parametric parts use
[`solidcraft`](../solidcraft/).

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Open DXF and DWG drawings or start a new one, draw lines, polylines, rectangles, arcs, circles, hatches, text,
dimensions and leaders, work with layers, blocks and layouts through 450+ commands of the desktop app (typed as at
the AutoCAD command line, as `.scr` scripts or as JSON), save DXF and DWG (2018), render PNG previews and export PDF
and SVG. Text renders with the fonts built into the engine, so no system fonts are needed. All files live in `/work`,
the container's working directory; results are handed to the user with `plugin_download_file`.

Tools (from `cadcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `new_drawing`, `open`, `save` | new drawing (`metric`: mm), open DXF/DWG from `/work`, save DXF/DWG or export PDF/SVG/PNG by the extension |
| `command_line` | one line at the command line: command names and aliases, points, distances, keywords (spaces act as Enter) |
| `script` | several lines at once, like an AutoCAD `.scr` file |
| `cancel` | abort the command waiting for input |
| `list_commands` | find engine commands by `filter`, with their parameter docs |
| `execute` | run one command with JSON params (`layer.new`, `plot`, `hatch`, …), no prompts |
| `inspect_drawing` | entity counts, extents, layers, styles, blocks, layouts, undo history |
| `query_entities`, `find_text` | entities by type, layer or window; text by content |
| `render` | PNG of the drawing or a window of it, saved into `/work` (the path is returned) |

Typical session ("draw a floor plan of a 4 × 5 m room with dimensions, return DXF and PDF"):

1. `cadcraft__new_drawing {"metric": true}` (units are millimetres).
2. `cadcraft__script {"text": "dimscale 50\nrectang 0,0 4000,5000\ndimlinear 0,0 4000,0 2000,-600\ndimlinear 4000,0 4000,5000 4600,2500\nzoom e\n"}`
   — `dimscale 50` makes the dimension text and arrows readable at the room's size.
3. `cadcraft__inspect_drawing {}` → `"counts": {"Dimension": 2, "Polyline": 1}`.
4. `cadcraft__render {"background": "white"}` → `/work/render-<time>.png`.
5. `cadcraft__save {"path": "/work/room.dxf"}` and `cadcraft__save {"path": "/work/room.pdf"}`, then
   `plugin_download_file`.

Saving over an existing DXF or DWG leaves the previous version next to it as `<name>.bak`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One CADCraft process per MCP session.** `initialize` starts `cadcraft-cli mcp` (cwd `/work`) over stdio; the
  session's `Mcp-Session-Id` maps to it. Closing the session (`DELETE`, idle timeout, SIGTERM) kills the process. An
  unknown session id gets HTTP 404 so the client re-initializes. A new session has an empty drawing only — the
  instructions tell the bot to save `.dxf` or `.dwg` files and reopen them.
- **tools/list, tools/call and resources are forwarded** to CADCraft (its own tool list and server instructions,
  with a WorkMux note on top). The headless server lists no desktop-only tools, so none are hidden.
- **Paths stay in `/work`.** CADCraft has no automation roots of its own (`"engineRoots": false` in `craft.json`), so
  the bridge checks the JSON arguments: top-level `path` arguments are resolved against `/work`, file keys inside
  `execute` params (`path`, `file`, `template`, …) are refused outside `/work` also when relative, and any other
  value that looks like a path (absolute, or going up with `..`) is checked as well; symlinks out of `/work` are
  refused too. Text typed through `command_line` and `script` goes to the engine as it is: its typed file prompts
  (`script`, `-insert`, `-xref`, …) and AutoLISP can open files by name, so for that text the container is the
  boundary. The plugin declares no secrets, and the container and `/work` are deleted after the conversation is idle.
- **No inline files.** The PNG of `render` is saved into `/work` and replaced by its path; so is the base64 `data` of
  `plot`, `exportpdf`, `publish` and `export` (PDF, SVG, PNG, DXF) without a `path` (`"base64Keys": ["data"]` in
  `craft.json`); a DWG `export` without a `path` is refused. `document.bytes` answers its `data` without a `format`,
  so the bridge cannot tell it from plain data and passes it on; the instructions never use it.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Rendering and plotting run on the CPU, so no GPU is needed. The preloaded `meminfo.c` shim caps `MemTotal` in
`/proc/meminfo` by the container's memory limit ([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

CADCraft **0.20.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `cadcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `cadcraft-cli` | the CADCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a CADCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | CADCraft processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `CADCRAFT_*` | — | passed to `cadcraft-cli` (e.g. `CADCRAFT_FONTALT`, the font that replaces a missing one) |

## Run locally

```sh
docker build -t workmux-plugin-cadcraft cadcraft
docker run --rm -p 8080:8080 workmux-plugin-cadcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). CADCraft itself is MIT/Apache-2.0; its licence files, and
those of the bundled fonts, are in the image under `/usr/share/doc/cadcraft`.
