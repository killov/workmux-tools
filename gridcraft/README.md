# GridCraft — WorkMux plugin

[GridCraft](https://getartcraft.com/apps/gridcraft) is an open-source spreadsheet written in Rust, one of the
[ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/gridcraft)). This plugin
runs its headless engine (`gridcraft-cli mcp`) in a container and exposes it to WorkMux bots as a streamable HTTP MCP
server. Bots see the tools as `gridcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Analyse and edit spreadsheets: values and formulas (500+ worksheet functions), tables, sorting and filtering,
conditional and number formatting, pivot tables, charts and pivot charts; open XLSX, ODS and CSV (the engine also
reads XLSM, XLS, XLSB, TSV and JSON); save XLSX and CSV (the active sheet) and export PDF. The engine also saves TSV,
JSON and HTML; those are not advertised in the manifest. All files live in `/work`, the container's working
directory; results are handed to the user with `plugin_download_file`.

Tools (from `gridcraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `open_workbook`, `new_workbook`, `save_workbook` | open a workbook from `/work`, start a blank one (or a sample), save it — the format follows the extension |
| `inspect_workbook`, `list_windows` | sheets, used ranges, tables, charts and names of the workbook; the open workbooks |
| `read_range`, `get_cell` | computed values of a range as rows (optionally formulas or formatted text); one cell in detail |
| `write_range`, `set_cell` | enter values and formulas (text starting with `=`) |
| `evaluate_formula` | evaluate a formula without changing a cell |
| `select` | set the selection (`Sheet2!A1` switches sheets) for the commands that act on it |
| `format_range`, `create_table`, `sort_range`, `filter` | formats, an Excel table, sort by columns, AutoFilter |
| `insert_chart` | a chart from a data range |
| `list_commands`, `execute_command` | find engine commands by `search` (`insert.pivotTable`, `insert.pivotChart`, `file.exportPdf`, …) and run them |
| `list_functions` | the worksheet functions by `search` or `category` |
| `undo`, `redo` | undo or redo changes |

Not listed: `screenshot` needs the desktop app.

Typical session ("make a pivot table and a chart from this CSV, return XLSX"):

1. Upload `sales.csv` (`Region,Product,Month,Sales`) to `/work`; `gridcraft__open_workbook {"path": "/work/sales.csv"}`.
2. `gridcraft__execute_command {"command": "insert.pivotTable", "params": {"rows": ["Region"], "columns": ["Product"],
   "values": [{"field": "Sales", "func": "sum"}]}}` — answers `PivotTable1` on the new sheet `Sheet1`, range `A3:D7`.
3. `gridcraft__execute_command {"command": "insert.pivotChart", "params": {"type": "column", "title": "Sales by region"}}`.
4. `gridcraft__read_range {"range": "Sheet1!A3:D7"}` shows the sums per region and product with the grand totals.
5. `gridcraft__save_workbook {"path": "/work/sales-pivot.xlsx"}`, then `plugin_download_file`. The XLSX keeps the
   pivot table with its cache and the chart.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One GridCraft process per MCP session.** `initialize` starts `gridcraft-cli mcp` (cwd `/work`) over stdio; the
  session's `Mcp-Session-Id` maps to it. Closing the session (`DELETE`, idle timeout, SIGTERM) kills the process.
  An unknown session id gets HTTP 404 so the client re-initializes. A new session has no open workbook and edits stay
  in memory until `save_workbook` — the instructions tell the bot to save after each stage.
- **tools/list, tools/call and resources are forwarded** to GridCraft (its own tool list and server instructions,
  with a WorkMux note on top), without `screenshot`.
- **Paths stay in `/work`.** GridCraft has no automation roots of its own (`"engineRoots": false` in `craft.json`),
  so the bridge is the only fence: top-level `path`-like arguments are resolved against `/work`, file keys inside
  `execute_command` params (`path`, `dir`, …) are refused outside `/work` also when relative, and any other value that
  looks like a path (absolute, or going up with `..`) is checked as well; symlinks out of `/work` are refused too.
  The check is by shape, so a cell value such as `/etc` in `write_range` is refused — the instructions tell the bot
  to rephrase it. Formulas (`=A1/B1`) start with `=` and pass. Cell references under such keys (`destination:
  "Sheet1!H3"`, `to: "C3"`) resolve inside `/work` and pass unchanged.
- **No inline files.** `file.exportPdf` and `file.print` without a `path` answer the PDF as `{"base64": ...}`; the
  bridge saves it into `/work` and answers its `path` (`base64Formats` in `craft.json`). `file.saveBytes` answers
  an XLSX, CSV, JSON or HTML under the same key; those bytes do not start like a PDF, so the bridge drops them and
  the call fails — `save_workbook` with a path does the same job.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Known limit: a workbook's macros and scripts (`macro.*`, `automate.runScript`) run inside the engine, where the bridge
does not see their file access. The engine refuses scripts of a workbook opened from a file unless the call passes
`"trusted": true`; past that, the container and its `/work` are the boundary.

Calculation and PDF export run on the CPU with the fonts built into the engine, so neither a GPU nor system fonts are
needed. The preloaded `meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

GridCraft **0.19.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `gridcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `gridcraft-cli` | the GridCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a GridCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity |
| `MAX_SESSIONS` | `4` | GridCraft processes at once; the least recently used is closed beyond it |
| `GRIDCRAFT_*` | — | passed to `gridcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-gridcraft gridcraft
docker run --rm -p 8080:8080 workmux-plugin-gridcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). GridCraft itself is MIT/Apache-2.0; its licence files, including
the OFL licences of the built-in fonts, are in the image under `/usr/share/doc/gridcraft`.
