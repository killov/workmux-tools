# MaterialCraft — WorkMux plugin

[MaterialCraft](https://getartcraft.com/apps/materialcraft) is an open-source procedural material designer in the
style of Substance Designer, written in Rust, one of the [ArtCraft](https://getartcraft.com/apps) applications
([source](https://github.com/storytold/materialcraft)). This plugin runs its headless engine (`materialcraft-cli mcp`)
in a container and exposes it to WorkMux bots as a streamable HTTP MCP server. Bots see the tools as
`materialcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Build PBR materials as node graphs (uniform colors, blend, levels, curves, gradient map, warp, blur, pixel and value
processors, FX map, normal, emboss, bitmaps, text), open SBS packages and `.mcraft` archives, import bitmaps (PNG,
JPEG, TGA, TIFF, BMP, WebP, EXR, HDR), cook the basecolor, normal, roughness, metallic, height and ambient occlusion
outputs, render the material on a 3D scene or one node in 2D as PNG, export the maps as PNG, JPEG, TGA, BMP, WebP,
OpenEXR or Radiance HDR, save the package as `.mcraft` or `.sbs` and write a portable `.mcmat` material for
TextureCraft. All files live in `/work`, the container's working directory; results are handed to the user with
`plugin_download_file`.

Version 0.4.1 ships atomic nodes only: there is no library of noise generators or material presets, so variation is
built from `blend`, `warp`, `gradient_map`, `pixel_processor`, `fx_map` and the other atomic nodes.

Tools (from `materialcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `graph_new` | new graph in the package; template `pbr` has six outputs fed by uniform nodes |
| `package_open`, `package_save` | open and save `.sbs`/`.mcraft` packages in `/work` |
| `session_inspect` | the open package and graph: nodes, params, connections, cooked values |
| `library_list` | node definitions with their inputs and params, by `filter` or `category` |
| `node_add`, `node_connect`, `node_param` | edit the graph |
| `command_list` | find engine commands by `filter`, with their parameter docs |
| `command_run`, `command_batch` | run one or several engine commands |
| `bitmap_import` | import an image from `/work` as a package resource |
| `view_render` | 3D (or 2D node) PNG preview, saved into `/work` (the path is returned) |
| `outputs_export` | cook the graph and write its outputs as image files into a folder in `/work` |
| `material_export` | write a portable `.mcmat` material into `/work` |

Typical session ("rusty metal material, 1024 px, return the PNG maps"):

1. `materialcraft__graph_new {"template": "pbr", "size": 1024, "name": "rust"}`; the uniform nodes 1, 3, 5, 7, 9 and
   11 feed basecolor, normal, roughness, metallic, height and ambientocclusion (`session_inspect` shows them).
2. `materialcraft__node_param {"id": 1, "param": "color", "value": "#8a3b12"}` (basecolor),
   `{"id": 5, "param": "color", "value": 0.75}` (roughness), `{"id": 7, "param": "color", "value": 0.4}` (metallic).
3. `materialcraft__view_render {"width": 1024, "height": 1024, "scene": "sphere"}` → `/work/view_render-<time>.png`.
4. `materialcraft__outputs_export {"dir": "/work/maps", "format": "png"}` →
   `{"files": ["maps/rust_basecolor.png", "maps/rust_normal.png", …]}` (relative to `/work`).
5. `materialcraft__package_save {"path": "/work/rust.mcraft"}`, then `plugin_download_file` for the maps.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One MaterialCraft process per MCP session.** `initialize` starts `materialcraft-cli mcp --automation-read-root
  /work --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing
  the session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session has an empty package — the instructions tell the bot to save `.mcraft` files.
- **tools/list, tools/call and resources are forwarded** to MaterialCraft (its own tool list and server
  instructions, with a WorkMux note on top). The bridge-only tools (`ui_*`, `view_screenshot`) need the desktop app
  and are not listed.
- **Paths stay in `/work`.** Top-level `path`/`dir` arguments of every tool are resolved against `/work` and refused
  outside it (symlinks included); file paths inside `command_run` params and `command_batch` steps and any other
  value that looks like a path (absolute, or going up with `..`) are checked too. MaterialCraft takes only
  forward-slash paths relative to its workspace root, so the bridge passes them on relative to `/work`
  (`"relativePaths": true`, [details](../craft-common/README.md#paths)): `/work/maps` reaches the engine as `maps`,
  and `/work` itself becomes `.`, which the engine refuses (export into a subfolder). The engine's answers name files relative to `/work` as well. MaterialCraft's own
  automation roots (`/work` only) stay on as a second fence.
- **No inline files.** The PNG of `view_render` is saved into `/work` and replaced by its path.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

MaterialCraft cooks and renders on the CPU, so no GPU is needed. The preloaded `meminfo.c` shim caps `MemTotal` in
`/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

MaterialCraft **0.4.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the
generated `Dockerfile` carries them as `ARG` defaults. Only `materialcraft-cli` and its licence files are extracted
from the package; the desktop app is not installed. To update, change `version` and both checksums in `craft.json`
from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `materialcraft-cli` | the MaterialCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a MaterialCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | MaterialCraft processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `MATERIALCRAFT_*` | — | passed to `materialcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-materialcraft materialcraft
docker run --rm -p 8080:8080 workmux-plugin-materialcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). MaterialCraft itself is MIT/Apache-2.0; its licence files are
in the image under `/usr/share/doc/materialcraft`.
