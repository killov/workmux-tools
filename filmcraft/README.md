# FilmCraft — WorkMux plugin

[FilmCraft](https://getartcraft.com/apps/filmcraft) is an open-source video editor written in Rust, one of the
[ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/filmcraft)). This plugin
runs its headless engine (`filmcraft-cli mcp`) in a container and exposes it to WorkMux bots as a streamable HTTP
MCP server. Bots see the tools as `filmcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Import video (MP4, MOV, WebM, MKV), audio (WAV, MP3, FLAC…) and stills (PNG, JPEG, GIF…), build sequences on a
multi-track timeline, place, cut, trim and move clips, add titles and shapes, transitions, effects, color grading,
audio mixing and captions — every menu action of the desktop app is an engine command — render PNG frames and export
H.264/AAC MP4, ProRes or DNxHR MOV, animated GIF, WAV and MP3. All files live in `/work`, the container's working
directory; results are handed to the user with `plugin_download_file`.

Tools (from `filmcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `media_import` | import files from `/work` into the project; returns their item ids |
| `command_list` | find engine commands by `filter` (700+, e.g. `file.newSequence`, `timeline.place`, `graphics.newText`, `file.exportMedia`), with their parameter docs |
| `command_run`, `command_batch` | run one or several engine commands |
| `doc_inspect`, `project_inspect`, `sequence_inspect` | project items, bins, sequences, tracks and clips with their ids |
| `render_preview`, `render_frame` | PNG of a timeline frame, saved into `/work` (the path is returned) |

Typical session ("join these two clips, add a title for 3 s, return MP4"):

1. Upload `clip1.mp4` and `clip2.mp4` to `/work`;
   `filmcraft__media_import {"paths": ["/work/clip1.mp4", "/work/clip2.mp4"]}` → items `[1, 2]`.
2. `filmcraft__command_run {"id": "file.newSequence", "params": {"name": "cut", "fromItem": 1}}`.
3. `filmcraft__command_run {"id": "timeline.place", "params": {"items": [1, 2], "track": "V1", "seconds": 0, "insert": false}}`.
4. `filmcraft__command_run {"id": "graphics.newText", "params": {"text": "Hello FilmCraft", "seconds": 3, "time": 0, "track": "new", "size": 48}}`.
5. `filmcraft__render_preview {"seconds": 1}` → `/work/render_preview-<time>.png`.
6. `filmcraft__command_run {"id": "file.exportMedia", "params": {"path": "/work/out.mp4", "wait": true}}`, then
   `plugin_download_file`.

`file.exportMedia` returns at once without `"wait": true` (poll `jobs.list` then). The engine has no WebM, VP9 or
AV1 encoder (it decodes them), and HEVC export needs a hardware encoder the container does not have; a `.webm` path
is written as `<name>.webm.mp4`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One FilmCraft process per MCP session.** `initialize` starts `filmcraft-cli mcp` (cwd `/work`) over stdio; the
  session's `Mcp-Session-Id` maps to it. Closing the session (`DELETE`, idle timeout, SIGTERM) kills the process.
  An unknown session id gets HTTP 404 so the client re-initializes. A new session has an empty project only — the
  instructions tell the bot to save `.fcproj` files (`file.saveAs`) and reopen them with `file.open`.
- **tools/list, tools/call and resources are forwarded** to FilmCraft (its own tool list and server instructions,
  with a WorkMux note on top). The `ui_*` tools, which drive the desktop app in bridge mode, are not listed.
- **Paths stay in `/work`.** FilmCraft has no automation roots of its own (`"engineRoots": false` in `craft.json`),
  so the bridge is the only fence: top-level `path`-like arguments are resolved against `/work`, file keys inside
  `command_run` params and `command_batch` steps (`path`, `dir`, `destination`, …) are refused outside `/work` also
  when relative, any other value that looks like a path (absolute, or going up with `..`) is checked as well, and
  lists of files (`media_import.paths`, `file.import.paths`, …) become absolute paths in `/work`; symlinks out of
  `/work` are refused too.
- **No inline files.** The PNG of `render_preview` and `render_frame` is saved into `/work` and replaced by its path;
  so is the `pngBase64` of `graphics.template.thumbnail` without a `path`.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 900 s, for long
  renders); startup to `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Rendering and encoding run on the CPU, so no GPU is needed; give the plugin more CPUs for faster exports. The
preloaded `meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

FilmCraft **0.20.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `filmcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `filmcraft-cli` | the FilmCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `900000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a FilmCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | FilmCraft processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `FILMCRAFT_*` | — | passed to `filmcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-filmcraft filmcraft
docker run --rm -p 8080:8080 workmux-plugin-filmcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). FilmCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/filmcraft`.
