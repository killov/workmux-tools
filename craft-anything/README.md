# Craft Anything — WorkMux plugin

[Craft Anything](https://getartcraft.com/apps/craft-anything) (early alpha) is an open-source workbench that studies
how software works and backs every claim with evidence, one of the [ArtCraft](https://getartcraft.com/apps)
applications ([source](https://github.com/storytold/craft-anything)). This plugin runs its headless engine
(`craft-anything-cli mcp`) in a container and exposes it to WorkMux bots as a streamable HTTP MCP server. Bots see the
tools as `craft-anything__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Open a program, app or file — ELF/PE/Mach-O programs and libraries, .NET assemblies, Java JAR/class, Android
APK/AAB/DEX, iOS IPA, Electron `app.asar` and JavaScript bundles, WebAssembly, firmware images, SQLite databases,
packet captures, Unity/Unreal game files — triage it, search functions and strings, read disassembly and pseudo-C,
follow cross-references and call paths, and write an investigation report (Markdown or self-contained HTML) whose
findings cite evidence ids. All files live in `/work`, the container's working directory; results are handed to the
user with `plugin_download_file`.

About 170 tools (from `craft-anything-cli mcp --restricted --deep --all-tools`), by group:

| Tools | What they do |
| --- | --- |
| `core_target_*`, `core_targets_list`, `core_session_show` | open (`core_target_open {path}`), triage, select and close targets |
| `core_overview_show`, `core_evidence_*`, `core_unknown*` | overview, the evidence ledger (browse, page, export/import a JSON bundle), open questions |
| `core_brief_write`, `core_plan_update`, `core_hypothesis_*`, `core_finding_*`, `core_handoff_write` | the investigation memory the report is built from |
| `core_report_write`, `core_report_save` | write the report as Markdown or HTML into `/work` |
| `native_*` | functions, strings, sections, bytes, cross-references, disassembly, pseudo-C, call graphs, PE resources, Go/Rust binaries |
| `managed_*`, `java_*`, `android_*`, `apple_*`, `harmony_*` | .NET assemblies, JAR/class files, APKs, Mach-O/IPA (Objective-C, Swift, plists, signatures) |
| `js_*`, `app_*` | Electron and web bundles (source maps, exports), app graphs, comparing builds |
| `formats_*`, `firmware_*`, `db_sqlite_show`, `packets_*`, `game_*`, `core_packed_files_*` | WebAssembly, bytecode, firmware regions, SQLite, captures, game archives, files packed inside a program |

Not listed:

- **Rebuilding a program** (`project_*`, `rebuild_*`, `build_*`) drives a local coding agent (Claude Code, Copilot)
  with its own login and network access, which the container does not have.
- **Desktop and setup** (`engines_*`, `settings_*`, `plugins_*`, `setup_*`, `ai_*`, `assets_*`): engine installs,
  settings, the AI layer and its keys.
- **Running or capturing things** (`web_*`, `runtime_*`, `frida_*`) and the approval/question tools
  (`core_person_ask`, `core_action_approve`) need a person at the desktop app.
- **External engines that are not in the image**: `native_objdump_run`, `native_rizin_*`, `native_gdb_*`,
  `managed_ilspy_decompile`, `java_vineflower_decompile`, `radio_*`.
- `core_archive_extract` unpacks into a temporary folder of the engine outside `/work`, whose paths the bot could not
  pass on (the tools that read archives take the `.zip`/`.apk`/`.asar` itself).

Typical session ("what does this program do? send me a report"):

1. The program is uploaded to `/work/sample.bin`; `craft-anything__core_target_open {"path": "/work/sample.bin"}` →
   `{"kind": "elf", "sha256": ..., "target_id": ...}`.
2. `craft-anything__core_target_triage {}` → x86_64 ELF, stripped, evidence id `ev_...`.
3. `craft-anything__core_overview_show {"detail": "summary"}`, then `native_strings_find {"pattern": "usage"}`,
   `native_function_pseudocode {"function": "0x..."}`.
4. `craft-anything__core_finding_record {"statement": "...", "evidence_ids": ["ev_..."]}`.
5. `craft-anything__core_report_write {"path": "/work/report.md"}` → `{"path": "/work/report.md", "format":
   "markdown"}`, then `plugin_download_file` of `/work/report.md`.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One Craft Anything process per MCP session.** `initialize` starts `craft-anything-cli mcp --restricted --deep
  --all-tools` (cwd `/work`) over stdio; the session's `Mcp-Session-Id` maps to it. Closing the session (`DELETE`,
  idle timeout, SIGTERM) kills the process. An unknown session id gets HTTP 404 so the client re-initializes. A new
  session starts with no open target and an empty investigation.
- **The switches come from `mcpArgs` in `craft.json`.** `--restricted` turns off every tool that runs code or changes
  a device; `--deep` lets the tools read the target's code and files (without it the engine is a clean room with no
  `core_target_open`); `--all-tools` lists every toolset at once, because the bridge lists tools once per session and
  `enable_toolset` would not reach the bot.
- **tools/list, tools/call and resources are forwarded** to Craft Anything (its own tool list and server
  instructions, with a WorkMux note on top), without the tools above.
- **Paths stay in `/work`.** The engine has no automation roots of its own (`"engineRoots": false`), so the bridge is
  the only fence: `path`/`folder`/`output`-like arguments are resolved against `/work` and refused outside it
  (symlinks included), and any other absolute path (`input_path`, `output_directory`, …) is checked too. `file` of
  the Unity/Unreal tools names a member inside a game archive, not a file in `/work` (`nonFileArgs`).
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 600 s, for large
  binaries); startup to `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Deep mode reads the target's code: use the plugin only for files the user may analyse (upstream: private use,
interoperability, security research).

## Version

Craft Anything **0.6.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the
generated `Dockerfile` carries them as `ARG` defaults. Only `craft-anything-cli` and its licence files are extracted
from the package; the desktop app is not installed. To update, change `version` and both checksums in `craft.json`
from the release's `SHA256SUMS.txt` (no `-rc` releases), run `node craft-common/sync.mjs` and check `tools/list` against
`hideTools`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `craft-anything-cli` | the Craft Anything CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `600000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a Craft Anything process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | Craft Anything processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `CRAFT_ANYTHING_*` | — | passed to `craft-anything-cli` |

## Run locally

```sh
docker build -t workmux-plugin-craft-anything craft-anything
docker run --rm -p 8080:8080 workmux-plugin-craft-anything
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). Craft Anything itself is MIT/Apache-2.0; its licence files are
in the image under `/usr/share/doc/craft-anything`.
