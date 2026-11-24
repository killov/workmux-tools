# LightCraft — WorkMux plugin

[LightCraft](https://getartcraft.com/apps/lightcraft) is an open-source, non-destructive photo library and raw
developer written in Rust, one of the [ArtCraft](https://getartcraft.com/apps) applications
([source](https://github.com/storytold/lightcraft)). This plugin runs its headless engine (`lightcraft-cli mcp`) in a
container and exposes it to WorkMux bots as a streamable HTTP MCP server. Bots see the tools as `lightcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Import camera raws (DNG, Canon CR2/CR3, Nikon NEF, Sony ARW, Fujifilm RAF incl. X-Trans, Olympus ORF, Panasonic RW2,
Pentax PEF) and JPEG, TIFF, PNG or WebP photos, develop them non-destructively — exposure, white balance, tone,
curves, color, detail, lens corrections, crop, presets and masks; every action of the desktop app is an engine
command — render previews and export JPEG, TIFF or PNG in full resolution. All files live in `/work`, the
container's working directory; results are handed to the user with `plugin_download_file`.

Tools (from `lightcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `import` | import files or folders from `/work` into the library; returns the photo ids |
| `list_controls` | develop sliders of a section (`light`, `color`, `effects`, `detail`, …) with ranges and current values |
| `get_develop`, `set_develop` | read all develop settings of a photo; set sliders by id (`light.exposure`, `wb.temp`, …) |
| `crop`, `apply_preset` | crop rectangle and angle; apply a develop preset |
| `query_photos`, `select_photos`, `doc_inspect` | find photos in the library, select them, library state |
| `command_list` | find engine commands by `filter` (about 390, e.g. `develop.wb`, `mask.add`, `photo.saveMetadataToFile`), with their parameter docs |
| `command_run`, `command_batch` | run one or several engine commands |
| `render_preview`, `render_photo` | PNG of the developed photo, saved into `/work` (the path is returned) |
| `export` | write the developed photo as JPEG, TIFF or PNG (format from the extension) |

The per-command tools `cmd_*` (one per registry command) and the duplicates `list_commands` / `run_command` are not
listed: `command_list` and `command_run` reach the same commands.

Typical session ("develop this raw, +0.5 EV, warmer white balance, return JPEG"):

1. Upload `IMG_0001.dng` to `/work`; `lightcraft__import {"paths": ["/work/IMG_0001.dng"]}` → `{"imported": [1]}`.
2. `lightcraft__list_controls {"section": "color"}` → `wb.temp` as shot, e.g. `4548`.
3. `lightcraft__set_develop {"values": {"light.exposure": 0.5, "wb.temp": 5350}}`.
4. `lightcraft__render_preview {}` → `/work/render_preview-<time>.png`.
5. `lightcraft__export {"path": "/work/IMG_0001.jpg", "quality": 90, "longEdge": 0}`, then `plugin_download_file`.

`export` without a size shrinks the long edge to 3000 px; `"longEdge": 0` keeps the full resolution (the
instructions tell the bot so). White balance presets go through `command_run {"id": "develop.wb", "params": {"mode":
"cloudy"}}`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One LightCraft process per MCP session.** `initialize` starts `lightcraft-cli mcp` (cwd `/work`) over stdio; the
  session's `Mcp-Session-Id` maps to it. Closing the session (`DELETE`, idle timeout, SIGTERM) kills the process.
  An unknown session id gets HTTP 404 so the client re-initializes. The headless library lives in memory only, so a
  new session starts empty — the instructions tell the bot to write XMP sidecars (`photo.saveMetadataToFile`), which
  the next import reads back.
- **tools/list, tools/call and resources are forwarded** to LightCraft (its own tool list and server instructions,
  with a WorkMux note on top), without the `ui_*`, `cmd_*`, `list_commands` and `run_command` tools.
- **Paths stay in `/work`.** LightCraft has no automation roots of its own (`"engineRoots": false` in `craft.json`),
  so the bridge is the only fence: top-level `path`-like arguments are resolved against `/work`, file keys inside
  `command_run` params and `command_batch` steps (`path`, `dir`, `folder`, `destination`, and LightCraft's `into`,
  `parent`, `previewPath`, `dataset`, `image`, `listing` from `fileKeys` in `craft.json`) are refused outside `/work`
  also when relative, and lists of files (`import.paths`, `preset.import.paths`, …) become absolute paths in `/work`;
  symlinks out of `/work` are refused too.
- **No inline files.** The PNG of `render_preview` and `render_photo` is saved into `/work` and replaced by its path.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 600 s, for large raws and
  batch exports); startup to `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Raw decoding and rendering run on the CPU, so no GPU is needed (the engine logs that it found no GPU adapter); give
the plugin more CPUs for faster exports. The preloaded `meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the
container's memory limit ([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

LightCraft **0.21.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `lightcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `lightcraft-cli` | the LightCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `600000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a LightCraft process |
| `SESSION_IDLE_MINUTES` | `60` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | LightCraft processes at once; the least recently used is closed beyond it |
| `LIGHTCRAFT_*` | — | passed to `lightcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-lightcraft lightcraft
docker run --rm -p 8080:8080 workmux-plugin-lightcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). LightCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/lightcraft`.
