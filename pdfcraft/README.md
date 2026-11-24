# PdfCraft — WorkMux plugin

[PdfCraft](https://getartcraft.com/apps/pdfcraft) is an open-source PDF workbench written in Rust, one of the
[ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/pdfcraft)). This plugin
runs its headless engine (`pdfcraft-cli mcp`) in a container and exposes it to WorkMux bots as a streamable HTTP MCP
server. Bots see the tools as `pdfcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Open PDFs, merge PDFs and images into one file, split, extract, reorder, rotate, insert, duplicate and delete pages,
password-protect and unlock, redact, add headers and footers, watermarks, Bates numbers, bookmarks, links, comments
and form fields, fill and sign forms, extract and edit text, compare documents, check PDF/A and accessibility,
reduce the file size, render PNG previews and save PDF, PNG/JPEG/TIFF page images, plain text and Word/HTML/Markdown.
All files live in `/work`, the container's working directory; results are handed to the user with
`plugin_download_file`.

Main tools (from `pdfcraft-cli mcp`, about 210 in total):

| Tool | What it does |
| --- | --- |
| `doc_open`, `doc_info`, `doc_save`, `doc_close` | open a PDF from `/work` (with `password` when encrypted), pages with size and rotation, save it |
| `doc_combine` | merge PDFs and images, in order, into a new document (or straight into `out`) |
| `page_rotate`, `page_delete`, `page_move`, `page_insert_file`, `page_extract`, `doc_split` | organize pages |
| `doc_protect`, `doc_unprotect` | AES-256 open password and permissions, applied by the next `doc_save` |
| `redact_mark`, `redact_apply`, `doc_watermark`, `doc_header_footer`, `form_fill`, `sign_document`, … | edit content |
| `text_extract`, `doc_export_text`, `doc_export_images`, `doc_export_office` | text, page images, Word/HTML/Markdown |
| `doc_print` | print-ready PDF into `/work` (booklet, n-up, poster, paper size) |
| `command_list`, `command_run`, `command_batch` | find and run engine commands by `filter` |
| `render_preview`, `page_render` | PNG of a page, saved into `/work` (the path is returned) |

Typical session ("merge these 3 PDFs, rotate page 2, password-protect it and return the PDF"):

1. Upload `a.pdf`, `b.pdf` and `c.pdf` to `/work`;
   `pdfcraft__doc_combine {"paths": ["/work/a.pdf", "/work/b.pdf", "/work/c.pdf"]}` → doc `1`, 3 pages.
2. `pdfcraft__page_rotate {"doc": 1, "degrees": 90, "pages": [2]}`.
3. `pdfcraft__doc_protect {"doc": 1, "open_password": "<password>"}`.
4. `pdfcraft__doc_save {"doc": 1, "path": "/work/merged.pdf"}`, then `plugin_download_file`.

`doc_open {"path": "/work/merged.pdf"}` now fails with "protected by a password"; with `"password"` it opens with 3
pages and `doc_info` shows page 2 rotated by 90°.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One PdfCraft process per MCP session.** `initialize` starts `pdfcraft-cli mcp --automation-read-root /work
  --automation-write-root /work` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the
  session (`DELETE`, idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client
  re-initializes. A new session has no open document and edits stay in memory until `doc_save` — the instructions
  tell the bot to save after each stage.
- **tools/list, tools/call and resources are forwarded** to PdfCraft (its own tool list and server instructions,
  with a WorkMux note on top). Not listed: the CUPS printer tools (`printers`, `printer_options`,
  `printer_papers`) — the container has no print spooler, `doc_print` with a `path` still writes the print-ready
  PDF; the Windows and macOS certificate stores (`sign_windows_ids`, `sign_keychain_ids`) — `sign_document` signs
  with a `.p12`/`.pfx` from `/work`; and text recognition (`ocr_*`), whose models are not in the image.
- **Paths stay in `/work`.** Top-level `path`/`dir`-like arguments of every tool are resolved against `/work` and
  refused outside it (symlinks included); absolute file paths inside `command_run` params and `command_batch` steps
  are checked too. PdfCraft's own automation roots (`/work` only) stay on as a second fence, also for nested paths
  such as `doc_combine.passwords` or `doc_bates_multi.files`.
- **No inline files.** The PNG of `render_preview` and `page_render` and the blobs of page image resources are saved
  into `/work` and replaced by their path.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Rendering runs on the CPU, so no GPU is needed. The preloaded `meminfo.c` shim caps `MemTotal` in `/proc/meminfo`
by the container's memory limit ([details](../craft-common/README.md#working-memory-in-a-container)).

Limits: no OCR (see above); Office, OpenDocument and RTF inputs of `doc_combine` need LibreOffice, which is not
installed — PDFs, images and `.txt` files merge, and `doc_export_office` (Word, PowerPoint, HTML, RTF, Markdown) is
built in.

## Version

PdfCraft **0.22.0**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `pdfcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `pdfcraft-cli` | the PdfCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a PdfCraft process |
| `SESSION_IDLE_MINUTES` | `60` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | PdfCraft processes at once; the least recently used is closed beyond it |
| `PDFCRAFT_*` | — | passed to `pdfcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-pdfcraft pdfcraft
docker run --rm -p 8080:8080 workmux-plugin-pdfcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). PdfCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/pdfcraft`.
