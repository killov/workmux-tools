# TextureCraft — WorkMux plugin

[TextureCraft](https://getartcraft.com/apps/texturecraft) is an open-source 3D texture painter written in Rust, one of
the [ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/texturecraft)). This
plugin runs its headless engine (`texturecraft-cli mcp`) in a container and exposes it to WorkMux bots as a
streamable HTTP MCP server. Bots see the tools as `texturecraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Import a mesh (GLB/glTF, FBX, OBJ, USD/USDA/USDC/USDZ, DAE, Alembic, PLY, STL; one texture set per material), apply
smart materials (wood, metals, stone, fabric, worn and rusty variants…), paint strokes, fill layers from images, bake
mesh maps (ambient occlusion, curvature, …), render PNG previews and export the PBR texture maps (PNG, JPEG, TGA, TIFF,
EXR) and the textured mesh (GLB, USDZ, USDA/USDC, OBJ). All files live in `/work`, the container's working
directory; results are handed to the user with `plugin_download_file`.

Tools (from `texturecraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `project_new`, `project_open`, `project_save` | start on a built-in mesh, open a `.tcraft` project or a mesh, save the project |
| `mesh_import`, `mesh_reimport` | new project from a mesh file, reload the mesh keeping the paint |
| `session_inspect` | texture sets, layer stack, tool, camera, history |
| `command_list` | find engine commands by `filter`, with their parameter docs |
| `command_run`, `command_batch` | run one or several engine commands (`material.list`, `material.apply`, `textureSet.select`, `layer.add.image`, `edit.undo`, …) |
| `paint_stroke` | paint through points in viewport pixels |
| `resource_import`, `material_load`, `material_save` | images for fill layers and stencils, `.tcmat` smart materials |
| `bake`, `bake_mesh_add` | bake mesh maps, add high-poly meshes or a cage |
| `viewport_render` | PNG of the 3D or UV view, saved into `/work` (the path is returned) |
| `mesh_export`, `textures_export` | textured mesh, texture maps |

Not listed: `ui_inspect`, `ui_menu_invoke`, `ui_screenshot` and `viewport_screenshot` work only in bridge mode
against a running desktop app and fail in the headless engine.

Typical session ("color this GLB model with a wood texture, return a GLB"):

1. The model is uploaded to `/work/crate.glb`; `texturecraft__mesh_import {"path": "crate.glb", "resolution": 1024}`.
2. `texturecraft__session_inspect {}` → three texture sets (Crate, Lid, Handle).
3. For each set `i`: `texturecraft__command_run {"id": "textureSet.select", "params": {"ts": i}}` and
   `texturecraft__command_run {"id": "material.apply", "params": {"material": "wood_oak"}}`.
4. `texturecraft__viewport_render {"width": 1024, "height": 1024}` → `/work/viewport_render-<time>.png`.
5. `texturecraft__mesh_export {"format": "glb", "path": "out/crate-wood.glb"}` → `{"path": "out/crate-wood.glb"}`,
   then `plugin_download_file` of `/work/out/crate-wood.glb`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One TextureCraft process per MCP session.** `initialize` starts `texturecraft-cli mcp --automation-read-root
  /work --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing
  the session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session starts with an empty project — the instructions tell the bot to save `.tcraft` files.
- **tools/list, tools/call and resources are forwarded** to TextureCraft (its own tool list and server instructions,
  with a WorkMux note on top), without the bridge-only tools above.
- **Paths stay in `/work` and reach the engine relative to it.** Top-level `path`/`dir`-like arguments are resolved
  against `/work` and refused outside it (symlinks included); file paths inside `command_run` params and
  `command_batch` steps and any other value that looks like a path are checked too. TextureCraft takes only
  forward-slash paths relative to its root and refuses absolute ones and `.`/`..` steps, so `craft.json` sets
  `"relativePaths": true`: `/work/out/x.glb` and `./out/x.glb` reach it as `out/x.glb`, `/work` as `.`. Its answers
  name files relative to `/work` too (`{"path": "out/x.glb"}`); the instructions tell the bot to prefix `/work/`.
  TextureCraft's own automation roots (`/work` only) stay on as a second fence, and it refuses engine commands with
  host paths (`file.exportMesh`, …) in `command_run`.
- **No inline files.** The PNG of `viewport_render` is saved into `/work` and replaced by its path.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 600 s, for bakes and
  large exports); startup to `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

`viewport_render` needs a Vulkan device and fails with "no GPU adapter" without one. The container has no GPU, so
the image installs Mesa's software Vulkan driver (`mesa-vulkan-drivers`, lavapipe, and `libvulkan1`, about 180 MB with
LLVM); renders run on the CPU, and `bake` uses its CPU ray tracer. A 1024 px preview takes a few seconds, a bake of ambient occlusion and curvature of three 1024 px texture sets about
a minute on 2 CPUs. TextureCraft sizes its working memory from `/proc/meminfo`, which shows the host's RAM; the
preloaded `meminfo.c` shim caps `MemTotal` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

TextureCraft **0.6.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the
generated `Dockerfile` carries them as `ARG` defaults. Only `texturecraft-cli` and its licence files are extracted
from the package; the desktop app and its X11/Wayland libraries are not installed. To update, change `version` and
both checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run
`node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `texturecraft-cli` | the TextureCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `600000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a TextureCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | TextureCraft processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `TEXTURECRAFT_*` | — | passed to `texturecraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-texturecraft texturecraft
docker run --rm -p 8080:8080 workmux-plugin-texturecraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). TextureCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/texturecraft`.
