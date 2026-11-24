# EffectCraft — WorkMux plugin

[EffectCraft](https://getartcraft.com/apps/effectcraft) is an open-source motion graphics and VFX compositor in the
style of After Effects, written in Rust, one of the [ArtCraft](https://getartcraft.com/apps) applications
([source](https://github.com/storytold/effectcraft)). This plugin runs its headless engine (`effectcraft-cli mcp`) in
a container and exposes it to WorkMux bots as a streamable HTTP MCP server. Bots see the tools as
`effectcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Build compositions with text, shape and solid layers, animate any property with keyframes and expressions, use 3D
layers, masks, track mattes and precompositions, apply effects (blur, glow, color correction…), import video (MP4,
MOV, WebM), images, After Effects projects (AEP) and Lottie — every menu action of the desktop app is an engine
command — render PNG frames and contact sheets and export H.264 MP4, ProRes MOV, WebM, GIF, PNG sequences and Lottie.
All files live in `/work`, the container's working directory; results are handed to the user with
`plugin_download_file`.

Tools (from `effectcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `command_list`, `describe_command` | find engine commands by `filter` (e.g. `comp.new`, `layer.newText`, `file.import`, `renderQueue.add`), with their parameter docs |
| `command_run`, `command_batch`, `batch` | run one or several engine commands; `batch` is one undo step and can pass a step's result to a later one (`"$1.layer"`) |
| `doc_inspect`, `get_project`, `get_comp`, `get_layer`, `get_state` | project items, compositions, layers and their property trees with ids and property paths |
| `get_property`, `set_property`, `add_keyframe` | read a property, set its value or expression, add keyframes; `path` is a property path (`transform/opacity`), not a file |
| `add_effect`, `list_effects`, `list_fonts` | apply an effect with its parameters; the effect registry; the fonts text layers can use |
| `render_preview`, `render_frame` | PNG of a frame (or a contact sheet of several times), saved into `/work` (the path is returned) |
| `open_project`, `save_project` | open or save an `.ecproj` project in `/work` |
| `undo`, `redo`, `history` | the undo stack |

Typical session ("make a 5 s animated title 'WorkMux' and return MP4"):

1. `effectcraft__command_run {"id": "comp.new", "params": {"name": "Title", "width": 1280, "height": 720, "frameRate": 30, "duration": 5}}` → `{"comp": 1}`.
2. `effectcraft__command_run {"id": "layer.newText", "params": {"text": "WorkMux"}}` → `{"layer": 2}`.
3. `effectcraft__add_keyframe {"layer": 2, "path": "transform/opacity", "keys": [{"time": 0, "value": 0}, {"time": 1.5, "value": 100}]}`.
4. `effectcraft__render_preview {"time": 2}` → `/work/render_preview-<time>.png`.
5. `effectcraft__command_run {"id": "renderQueue.add", "params": {"comp": "Title", "format": "h264", "output": "/work/title.mp4"}}`.
6. `effectcraft__command_run {"id": "renderQueue.render", "params": {"wait": true}}` → `"failed": 0`, `"last_output": "/work/title.mp4"`;
   then `plugin_download_file`.

`renderQueue.add` takes `format` `h264` (MP4), `prores` (MOV), `webm`, `gif` or `png`; for `png` the `output` is a
template with `#` digits for the frame number: `/work/seq/title_[####].png` writes `title_0000.png`,
`title_0001.png`, … into `/work/seq` (one file per frame, downloaded one by one). Paths inside `command_run` params
must be absolute (`/work/...`): the engine refuses relative ones.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One EffectCraft process per MCP session.** `initialize` starts `effectcraft-cli mcp --automation-read-root /work
  --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the
  session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session has an empty project only — the instructions tell the bot to save `.ecproj` files.
- **tools/list, tools/call and resources are forwarded** to EffectCraft (its own tool list and server instructions,
  with a WorkMux note on top). Not listed: `ui_*` and `screenshot`, which drive the desktop app in bridge mode;
  `run_script` and `script_ui`, which the engine refuses with automation roots; `list_commands` and
  `execute_command`, duplicates of `command_list` and `command_run`.
- **Paths stay in `/work`.** Top-level `path`/`dir`-like arguments of every tool are resolved against `/work` and
  refused outside it (symlinks included); file paths inside `command_run` params and `command_batch` steps (also
  relative ones) and any other value that looks like a path (absolute, or going up with `..`) are checked too. The
  `path` of `get_property`, `set_property` and `add_keyframe` is a property path, so it is passed on unchanged
  (`nonFileArgs` in `craft.json`). EffectCraft's own automation roots (`/work` only) stay on as a second fence.
- **No inline files.** The PNG of `render_preview` and `render_frame` is saved into `/work` and replaced by its path.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 900 s, for long
  renders); startup to `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Rendering and encoding run on the CPU, so no GPU is needed; give the plugin more CPUs for faster renders. The
preloaded `meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

EffectCraft **0.25.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the
generated `Dockerfile` carries them as `ARG` defaults. Only `effectcraft-cli` and its licence files are extracted
from the package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version`
and both checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run
`node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `effectcraft-cli` | the EffectCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `900000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of an EffectCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | EffectCraft processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `EFFECTCRAFT_*` | — | passed to `effectcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-effectcraft effectcraft
docker run --rm -p 8080:8080 workmux-plugin-effectcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). EffectCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/effectcraft`.
