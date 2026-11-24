# DesignCraft — WorkMux plugin

[DesignCraft](https://getartcraft.com/apps/designcraft) is an open-source page layout and publishing application
written in Rust, one of the [ArtCraft](https://getartcraft.com/apps) applications
([source](https://github.com/storytold/designcraft)). This plugin runs its headless engine (`designcraft-cli mcp`) in
a container and exposes it to WorkMux bots as a streamable HTTP MCP server. Bots see the tools as
`designcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Create documents from page presets (A4, Letter, …) or open DesignCraft projects, IDML and InDesign `.indd`/`.indt`
files (converted to IDML); lay out text frames with columns, character and paragraph styles and threading; place
images (PNG, JPEG, WebP, GIF, TIFF), PDF pages, Word/RTF/Markdown/plain text and Excel tables; every action of the
desktop app is an engine command. Pages render to PNG previews and export as print PDF (PDF/X-4, PDF/X-1a), PNG or JPEG pages, IDML and EPUB.
All files live in `/work`, the container's working directory; results are handed to the user with
`plugin_download_file`.

Tools (from `designcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `new_document` | new active document from a `preset` (`A4`, `Letter`, …) or `width`/`height` in points, with columns, margins, bleed |
| `open_document`, `save_document` | open a `.designcraft`, IDML or InDesign `.indd`/`.indt` file (converted to IDML); save the document as `.designcraft` |
| `inspect_document` | pages, frames (bounds, columns), stories (overset), styles, swatches, selection |
| `get_story`, `set_story_text` | read and replace the text of a story |
| `place_image` | place an image from `/work` into a frame or a new frame at `x`, `y`, `width` |
| `list_commands` | find engine commands by `filter` (`frame.create`, `type.char`, `object.textFrameOptions`, `file.exportPdf`, …), with their parameter docs |
| `execute`, `batch` | run one or several engine commands (`batch` passes results on with `"$0.id"`) |
| `render_page` | PNG of a page, saved into `/work` (the path is returned) |
| `export_png` | write a page as PNG or JPEG |
| `select_tool`, `pointer`, `key`, `type_text`, `ime` | drive the tools, pointer and keyboard like a user |

The desktop-only tools (`screenshot`, `click`, `drag`, `menu_list`, `ui_*`, `dialog_*`) only return an error in the
headless engine and are not listed.

Typical session ("lay out an A4 flyer with a headline, an image and two columns of text, return PDF"):

1. Upload `photo.png` to `/work`; `designcraft__new_document {"preset": "A4"}` (595.28 × 841.89 pt, margins 36 pt).
2. `designcraft__execute {"command": "frame.create", "params": {"rect": [36, 36, 559, 100], "content": "text",
   "text": "Summer Fair 2026"}}` → `{"id": 8, "story": 9}`.
3. `designcraft__place_image {"path": "/work/photo.png", "x": 36, "y": 120, "width": 523}`.
4. `designcraft__execute {"command": "frame.create", "params": {"rect": [36, 470, 559, 806], "content": "text",
   "text": "…"}}`, then `designcraft__execute {"command": "object.textFrameOptions", "params": {"columns": 2,
   "gutter": 12}}` (the caret is still in the new frame).
5. `designcraft__inspect_document {}` → three items, the text frame with `"columns": 2`; `designcraft__render_page
   {"page": 0}` → `/work/render_page-<time>.png`.
6. `designcraft__execute {"command": "file.exportPdf", "params": {"path": "/work/flyer.pdf"}}`, then
   `plugin_download_file`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One DesignCraft process per MCP session.** `initialize` starts `designcraft-cli mcp --automation-read-root /work
  --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the
  session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. The open document lives in the process only, so a new session starts empty — the instructions tell
  the bot to save into `/work`.
- **tools/list, tools/call and resources are forwarded** to DesignCraft (its own tool list and server instructions,
  with a WorkMux note on top), without the desktop-only tools.
- **Paths stay in `/work`.** The engine itself refuses files outside its read and write roots (`/work`); on top of
  that the bridge resolves top-level `path`-like arguments against `/work` and refuses them outside it (symlinks
  included); file paths inside `execute` params and `batch` steps are checked too. The check is by shape: any string
  argument that starts with `/` or `../` counts as a path, so a text such as `/etc` in `set_story_text` is refused.
- **No inline files.** DesignCraft accepts and returns file bytes as `base64` (`place_image`, `file.place`, and
  `file.exportPdf`/`file.exportIdml`/`file.exportEpub` without a `path`). The bridge removes `base64` from the tools'
  input schemas and refuses it in arguments, also inside `execute` params, `batch` steps and a `batch` `script`
  (`"argBase64Keys"` and `"jsonTextKeys"` in `craft.json`). `file.exportPdf` without a `path` answers a file in
  `/work`: the PDF is saved as `.pdf` and its `path` returned (`"base64Formats"`); `file.exportIdml` and
  `file.exportEpub` without a `path` fail without returning the bytes, so export them with a `path`. A `base64`
  that holds no file bytes (`list_commands` describes the parameter as `"base64": "string"`) passes unchanged, and a
  text such as `{"base64": "x"}` in `set_story_text` is not refused. The PNG of `render_page` is saved into `/work`
  and replaced by its path (`"previewTools"`).
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s, for long documents
  and PDF/X exports); startup to `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Layout and rendering run on the CPU, so no GPU is needed; the fonts ship inside the engine. The preloaded
`meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

DesignCraft **0.21.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the
generated `Dockerfile` carries them as `ARG` defaults. Only `designcraft-cli` and its licence files are extracted from
the package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `designcraft-cli` | the DesignCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a DesignCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | DesignCraft processes at once; the least recently used is closed beyond it |
| `DESIGNCRAFT_*` | — | passed to `designcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-designcraft designcraft
docker run --rm -p 8080:8080 workmux-plugin-designcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). DesignCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/designcraft`.
