# PhotoCraft — WorkMux plugin

[PhotoCraft](https://getartcraft.com/apps/photocraft) is an open-source, PSD-compatible image editor written in Rust,
one of the [ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/photocraft)).
This plugin runs its headless engine (`photocraft-cli mcp`) in a container and exposes it to WorkMux bots as a
streamable HTTP MCP server. Bots see the tools as `photocraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Open photos and layered documents (PSD/PSB, TIFF, PNG, JPEG, WebP, HEIC, GIF, XCF, Krita, OpenRaster, Paint.NET,
SVG, PDF, Affinity Photo, `.pcraft`), edit them with the 500+ commands of the desktop app — crop and resize, layers
and masks, adjustment layers, filters, brightness/contrast, levels, curves, type — render PNG previews and export
PNG, JPEG, WebP, TIFF, PSD/PSB, OpenRaster, GIF, BMP, TGA, OpenEXR or PDF. All files live in `/work`, the
container's working directory; results are handed to the user with `plugin_download_file`.

Tools (from `photocraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `doc_new`, `doc_open`, `doc_close`, `doc_select`, `session_list` | create, open and switch documents |
| `command_list` | find engine commands by `filter`, with their parameter docs |
| `command_run`, `command_batch` | run one or several engine commands |
| `doc_inspect` | layer tree, history, selection, size |
| `render_preview`, `doc_render_preview` | flattened PNG preview, saved into `/work` (the path is returned) |
| `doc_save`, `doc_export`, `doc_export_layers`, `doc_export_data_sets` | write files into `/work` |
| `doc_place`, `doc_replace_smart_object`, `doc_import_data_sets` | read more files from `/work` into the document |
| `jobs_list`, `jobs_cancel` | long-running filters |

Typical session ("crop to 16:9, sharpen, add contrast, return a PNG"):

1. The photo is uploaded to `/work/photo.jpg`; `photocraft__doc_open {"path": "/work/photo.jpg"}`.
2. `photocraft__command_list {"filter": "crop"}` → `image.crop`.
3. `photocraft__command_run {"id": "image.crop", "params": {"x": 0, "y": 112, "width": 1200, "height": 675}}`.
4. `photocraft__command_run {"id": "filter.sharpen.smartSharpen", "params": {"amount": 80}}`.
5. `photocraft__command_run {"id": "image.adjustments.brightnessContrast", "params": {"contrast": 30}}`.
6. `photocraft__render_preview {}` → `/work/render_preview-<time>.png`.
7. `photocraft__doc_export {"path": "/work/photo-16x9.png"}`, then `plugin_download_file`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One PhotoCraft process per MCP session.** `initialize` starts `photocraft-cli mcp --automation-read-root /work
  --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the
  session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session has no open document — the instructions tell the bot to save `.psd`/`.pcraft` files.
- **tools/list, tools/call and resources are forwarded** to PhotoCraft (its own tool list and server instructions,
  with a WorkMux note on top). The bridge-only tools (`ui_*`, `control_call`) need the desktop app and are not listed.
- **Paths stay in `/work`.** Top-level `path`/`dir`-like arguments of every tool are resolved against `/work` and
  refused outside it (symlinks included); file paths inside `command_run` params and `command_batch` steps (also
  relative ones) and any other value that looks like a path (absolute, or going up with `..`) are checked too. PhotoCraft's
  own automation roots (`/work` only) stay on as a second fence.
- **No inline files.** The PNG of `render_preview` is saved into `/work` and replaced by its path.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Rendering uses PhotoCraft's CPU compositor, so no GPU is needed. PhotoCraft sizes its working memory from
`/proc/meminfo`, which shows the host's RAM; the preloaded `meminfo.c` shim caps `MemTotal` by the container's
memory limit, otherwise filters fail with "not enough working memory" on a large host
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

PhotoCraft **0.23.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the
generated `Dockerfile` carries them as `ARG` defaults. Only `photocraft-cli` and its licence files are extracted
from the package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version`
and both checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run
`node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `photocraft-cli` | the PhotoCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a PhotoCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | PhotoCraft processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `PHOTOCRAFT_*` | — | passed to `photocraft-cli` (e.g. `PHOTOCRAFT_GPU`) |

## Run locally

```sh
docker build -t workmux-plugin-photocraft photocraft
docker run --rm -p 8080:8080 workmux-plugin-photocraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). PhotoCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/photocraft`.
