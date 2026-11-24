# DeckCraft — WorkMux plugin

[DeckCraft](https://getartcraft.com/apps/deckcraft) is an open-source presentation editor written in Rust, one of the
[ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/deckcraft)). This plugin
runs its headless engine (`deckcraft-cli mcp`) in a container and exposes it to WorkMux bots as a streamable HTTP MCP
server. Bots see the tools as `deckcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Build and edit slide decks: slides with layouts, text, shapes, pictures, tables, charts, SmartArt, themes, transitions,
animations and speaker notes; open PPTX (and DeckCraft's own `.deckcraft`); save PPTX, export PDF (slides, notes or
handouts) and PNG slides. The engine also exports JPEG, animated GIF and an RTF outline; those are not advertised in
the manifest. ODP is not supported by the engine. All files live in `/work`, the container's working directory;
results are handed to the user with `plugin_download_file`.

Tools (from `deckcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `new_presentation`, `open_presentation`, `save_presentation` | start a deck with a `theme`, open a `.pptx` from `/work`, save it |
| `export` | PDF, PNG (`all` for every slide: `slide.png` → `slide1.png`, `slide2.png`, …), JPEG, GIF, outline, into `/work` |
| `inspect_document`, `inspect_slide` | the slides, layouts and fonts; one slide's shapes with their ids (slide indexes start at 0) |
| `add_slide`, `go_to_slide` | a slide with a `layout`, `title` and `body` (one bullet per line); move to a slide |
| `add_shape`, `add_text_box`, `set_text` | a preset shape or a text box on the current slide; replace the text of a shape by id |
| `insert_picture`, `insert_table`, `insert_chart` | a picture from `/work`, a table from `data`, a chart from `categories` and `series` |
| `select` | select shapes by id for the commands that act on the selection |
| `list_commands`, `run_command`, `batch` | find engine commands by `filter` (transition, animation, theme, notes, …) and run them |
| `render_slide` | PNG of a slide, saved into `/work` (the path is returned) |

Not listed: `screenshot` and `call_app` need the desktop app; `pointer`, `select_tool`, `key` and `type_text` emulate
mouse and keyboard input in the UI — `add_text_box`, `set_text` and `run_command` do the same directly.

Typical session ("make 5 slides about the product, return PPTX and PDF"):

1. `deckcraft__new_presentation {"theme": "Harbor"}` — one title slide.
2. `deckcraft__inspect_slide {"index": 0}` shows the title placeholder's id;
   `deckcraft__set_text {"id": 258, "text": "Acme Widget"}`.
3. Four times `deckcraft__add_slide {"layout": "titleAndContent", "title": "Pricing", "body": "Free tier\nPro\nTeam"}`.
4. `deckcraft__inspect_document {}` shows 5 slides; `deckcraft__render_slide {"slide": 1}` saves a preview PNG.
5. `deckcraft__save_presentation {"path": "/work/product.pptx"}`,
   `deckcraft__export {"format": "pdf", "path": "/work/product.pdf"}`, then `plugin_download_file` for both.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One DeckCraft process per MCP session.** `initialize` starts `deckcraft-cli mcp --automation-read-root /work
  --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the
  session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session has no open presentation and edits stay in memory until `save_presentation` — the
  instructions tell the bot to save after each stage.
- **tools/list, tools/call and resources are forwarded** to DeckCraft (its own tool list and server instructions,
  with a WorkMux note on top), without the tools listed above as not listed.
- **Paths stay in `/work`.** Top-level `path`-like arguments of every tool are resolved against `/work` and refused
  outside it (symlinks included); absolute file paths inside `run_command` params and `batch` steps are checked too.
  DeckCraft's own automation roots (`/work` only) stay on as a second fence. The check is by shape: any string
  argument that starts with `/` or `../` counts as a path, so text such as `/etc` in a slide title or `set_text` is
  refused — the instructions tell the bot to rephrase it.
- **No inline files.** The PNG of `render_slide` is saved into `/work` and replaced by its path. So are the file bytes
  that `file.render` (`{"png": ...}`) and `file.saveBytes` (`{"data": ...}`, a `.deckcraft` file) answer through
  `run_command` and `batch` (`base64Formats` in `craft.json`). `export` refuses to run without a `path`.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Layout, rendering and PDF export run on the CPU with the fonts built into the engine, so neither a GPU nor system
fonts are needed. A PPTX that uses fonts the engine does not have (e.g. Arial or Calibri) is drawn with a substitute;
`open_presentation` lists them as `missingFonts`, and `list_commands {"filter": "font"}` finds `font.replace`. The
preloaded `meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

DeckCraft **0.18.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `deckcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `deckcraft-cli` | the DeckCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a DeckCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | DeckCraft processes at once; the least recently used is closed beyond it |
| `DECKCRAFT_*` | — | passed to `deckcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-deckcraft deckcraft
docker run --rm -p 8080:8080 workmux-plugin-deckcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). DeckCraft itself is MIT/Apache-2.0; its licence files, including
the OFL licences of the built-in fonts, are in the image under `/usr/share/doc/deckcraft`.
