# WordCraft — WorkMux plugin

[WordCraft](https://getartcraft.com/apps/wordcraft) is an open-source word processor written in Rust, one of the
[ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/wordcraft)). This plugin
runs its headless engine (`wordcraft-cli mcp`) in a container and exposes it to WorkMux bots as a streamable HTTP MCP
server. Bots see the tools as `wordcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Write and edit documents: paragraph and character styles, headings, tables, lists, page setup, track changes,
comments and mail merge; open DOCX, DOC, ODT, RTF, Markdown, HTML, plain text and TeX (Markdown headings and tables
become Heading N styles and real tables); save DOCX, ODT, RTF, Markdown, HTML, TeX and plain text, export PDF and
render PNG page previews. All files live in `/work`, the container's working directory; results are handed to the
user with `plugin_download_file`.

Tools (from `wordcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `new_document`, `open_document`, `save_document` | start from a template, open a document from `/work`, save it (the format follows the extension) |
| `list_documents` | the open documents |
| `type_text`, `select_text`, `get_text` | type at the caret (`paragraphs` splits on new lines), select, read the plain text |
| `insert_table` | a table from a 2D array of `values`, with an optional `header` row and `style` |
| `inspect_document` | the blocks with their styles, tables and lists as JSON |
| `list_commands`, `execute`, `batch` | find engine commands by `query` (heading, table, list, track, …) and run them |
| `render_page` | PNG of a page, saved into `/work` (the path is returned) |

Typical session ("make a document with headings and a table out of this text, return DOCX and PDF"):

1. Upload `notes.md` (a `# Quarterly report` heading, an intro, a `## Results` heading and a paragraph) to `/work`;
   `wordcraft__open_document {"path": "/work/notes.md"}`.
2. `wordcraft__execute {"command": "caret.docEnd"}`, `wordcraft__execute {"command": "text.newParagraph"}`.
3. `wordcraft__insert_table {"values": [["Region", "Revenue"], ["North", "120"], ["South", "95"]], "header": true}`.
4. `wordcraft__inspect_document {}` shows the Heading1 and Heading2 paragraphs and the table.
5. `wordcraft__save_document {"path": "/work/report.docx"}`, `wordcraft__save_document {"path": "/work/report.pdf"}`,
   then `plugin_download_file` for both.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One WordCraft process per MCP session.** `initialize` starts `wordcraft-cli mcp --automation-read-root /work
  --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the
  session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session has no open document and edits stay in memory until `save_document` — the
  instructions tell the bot to save after each stage.
- **tools/list, tools/call and resources are forwarded** to WordCraft (its own tool list and server instructions,
  with a WorkMux note on top). Not listed: `screenshot`, `click`, `key` and `ui_inspect`, which drive or report on an
  attached desktop window and do nothing headless (`render_page` renders a page, `execute` runs what a click or key
  would), and `parity`, a report of the desktop UI against the command registry that does not help a bot write a
  document.
- **Paths stay in `/work`.** Top-level `path`-like arguments of every tool are resolved against `/work` and refused
  outside it (symlinks included); absolute file paths inside `execute` params and `batch` steps are checked too.
  WordCraft's own automation roots (`/work` only) stay on as a second fence. The check is by shape: any string
  argument that starts with `/` or `../` counts as a path, so text such as `/etc` in `type_text` or a table cell is
  refused — the instructions tell the bot to rephrase it.
- **No inline files.** The PNG of `render_page` is saved into `/work` and replaced by its path.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Layout and PDF export run on the CPU with the fonts built into the engine, so neither a GPU nor system fonts are
needed. New documents and Markdown/text inputs get WordCraft's default page size (US Letter without a locale);
documents opened from DOCX/ODT keep theirs, and `list_commands {"query": "page"}` finds the page setup commands. The
preloaded `meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

WordCraft **0.18.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `wordcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `wordcraft-cli` | the WordCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a WordCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | WordCraft processes at once; the least recently used is closed beyond it |
| `WORDCRAFT_*` | — | passed to `wordcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-wordcraft wordcraft
docker run --rm -p 8080:8080 workmux-plugin-wordcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). WordCraft itself is MIT/Apache-2.0; its licence files, including
the OFL licences of the built-in fonts, are in the image under `/usr/share/doc/wordcraft`.
