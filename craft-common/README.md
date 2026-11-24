# craft-common — shared base of the ArtCraft plugins (not a plugin)

The [ArtCraft](https://getartcraft.com/apps) applications (PhotoCraft, FilmCraft, VectorCraft, …) share one headless
CLI convention: `<app>-cli mcp --automation-read-root <dir> --automation-write-root <dir>` serves the same MCP tools
(`command_list`, `command_run`, `command_batch`, `doc_*`, `render_preview`, …) over stdio, and every release ships
`<app>-<version>-linux-<arch>.deb` with `/usr/bin/<app>-cli` plus a `SHA256SUMS.txt`. A Craft plugin is therefore
the same bridge and the same Dockerfile with different values; this folder holds them once.

## Why copies

WorkMux builds a plugin from its own folder only (`build.context` is the plugin folder), so a plugin cannot import
code from a sibling folder at build time, and downloading the shared code during the build would leave it unpinned.
Each Craft plugin therefore carries a **generated copy** of the shared files, committed in git. `sync.mjs` writes
the copies; `sync.mjs --check` (run by the plugin gate for every folder with a `craft.json`) fails when a copy
differs from this folder.

| File | Becomes in `<app>/` |
| --- | --- |
| `server.mjs` | `server.mjs` with a GENERATED header — stdio MCP → streamable HTTP bridge, `/work` confinement, inline images to files; reads `/app/craft.json` at runtime |
| `meminfo.c` | `meminfo.c` with a GENERATED header — preloaded shim that caps `MemTotal` in `/proc/meminfo` by the container's memory limit (see below) |
| `package.json`, `package-lock.json` | identical copies (`npm ci` in the image) |
| `Dockerfile.in` | `Dockerfile` with the `craft.json` values as `ARG` defaults (`APP`, `REPO`, `VERSION`, `SHA256_X86_64`, `SHA256_AARCH64`) and the extra apt packages |
| `sync.mjs` | — the generator |

The manifest (`workmux-plugin.json`) and the plugin's `README.md` are written by hand: description, instructions and
file types differ per application.

## Working memory in a container

The Craft engines size their working memory from `/proc/meminfo` and the memory cgroup, but keep a headroom of 5% of
`MemTotal` (at least 256 MB) for the rest of the system. In a container `MemTotal` is the host's RAM: on a 48 GB host
the headroom is 2.4 GB, more than a 2 GB container limit, and every filter fails with "not enough working memory".
`meminfo.c` is built in the first stage and listed in `/etc/ld.so.preload`; it serves `/proc/meminfo` to the
engine's `open64` with `MemTotal` capped by the cgroup limit (`memory.max`, or v1 `memory.limit_in_bytes`), so the
headroom follows the container's `resources.memoryMb`. Without a limit the file is unchanged.

## craft.json

```json
{
  "app": "photocraft",
  "name": "PhotoCraft",
  "repo": "storytold/photocraft",
  "version": "0.23.1",
  "sha256": { "x86_64": "<64 hex>", "aarch64": "<64 hex>" },
  "aptPackages": [],
  "hideTools": ["^ui_", "^control_call$"],
  "callTimeoutMs": 300000
}
```

| Key | Meaning |
| --- | --- |
| `app` | the folder name, the plugin slug and the CLI name prefix (`<app>-cli`) |
| `name` | human name used in the server's messages |
| `repo` | GitHub `<owner>/<repo>` with the releases |
| `version` | a release `x.y.z` (no `-rc`) |
| `sha256` | SHA-256 of `<app>-<version>-linux-x86_64.deb` and `…-aarch64.deb` from the release's `SHA256SUMS.txt` |
| `aptPackages` | extra Debian packages the CLI needs at runtime (check with `ldd`); `tini` is always installed |
| `hideTools` | regular expressions of tools not offered to bots (the bridge-only ones need the desktop app) |
| `callTimeoutMs` | default limit of one tool call (`CRAFT_CALL_TIMEOUT_MS` overrides it) |
| `engineRoots` | optional, default `true`; `false` for an engine without `--automation-read-root`/`--automation-write-root` (FilmCraft) — see below |
| `mcpArgs` | optional; further switches after `mcp` for an engine that hides tools behind them (Craft Anything `--restricted`, `--deep`, `--all-tools`); switches only, no values and no `--automation-*` (sync.mjs refuses them) |
| `relativePaths` | optional, default `false`; `true` for an engine that takes only forward-slash paths relative to its roots and refuses absolute ones (TextureCraft) — see below; cannot be combined with `encodeMp3` |
| `fileKeys` | optional; further argument keys that name files or folders in the app's commands (LightCraft `folder.move` `into`, `folder.create` `parent`, …), checked like `path` inside `command_run` params and `command_batch` steps |
| `nonFileArgs` | optional; tool name → top-level argument keys of that tool that look like file keys but are not files (EffectCraft `set_property` `path` is a property path like `transform/opacity`: `{"set_property": ["path"]}`); they are passed on unchanged and checked like any other string (see below) |
| `base64Keys` | optional; further JSON keys of file bytes in the app's answers besides `dataBase64`/`pngBase64` (FigCraft `export` without a path answers `{"format": ..., "data": ...}`); next to a `format` each becomes a file in `/work` and its `path`, without one it stays plain data |
| `encodeMp3` | optional, default `false`; `true` adds the bridge's own `encode_mp3` tool for an engine that bounces audio but cannot write MP3 (SoundCraft) — see below; put `lame` into `aptPackages` |
| `base64Formats` | optional; JSON keys of file bytes in every answer of the app, also without a `format` next to them, mapped to the format of those bytes (DeckCraft `file.render` answers `{"png": ...}`, `file.saveBytes` `{"data": ...}`: `{"png": "png", "data": "deckcraft"}`); a `format` in the answer wins, bytes that do not match the mapped format are refused (see below) |

## Paths

The bridge checks every tool argument before the child sees it; a value outside `/work` (also through a symlink)
fails the call with an error that names the argument:

- top-level file keys (`path`, `file`, `dir`, `out`, …) are resolved against `/work` and passed on as absolute paths,
  except the keys `nonFileArgs` names for a tool: they are not files there (EffectCraft `add_keyframe.path` is a
  property path), so they are passed on unchanged and refused only when they look like a path outside `/work`; their
  schema description does not get the "inside `/work`" note either,
- the same keys inside `command_run` params and `command_batch` steps are checked also when relative but passed on
  unchanged (a relative `path` there can be an object id, e.g. VectorCraft's `path-3`, which resolves inside),
- any other string, under any key and at any depth, is checked when it looks like a path: absolute, `..`, or
  containing a `../` step. A text that starts with `/` is refused as well; that is the price of the general rule.

With `"relativePaths": true` the checked file paths reach the child relative to `/work` instead (`/work/out/x.glb`
and `./out/x.glb` become `out/x.glb`, `/work` itself becomes `.`), at the top level and under the file keys inside
`command_run` params and `command_batch` steps alike. TextureCraft refuses an absolute path even inside its root, and
a path with a `.` or `..` step. The engine's answers name files relative to `/work` as well; the bridge leaves them as
they are and the plugin's instructions say so.

With `"engineRoots": false` the child runs as plain `<app>-cli mcp` in `/work` and the bridge is the only fence
around `/work`: file keys inside `command_run` params and `command_batch` steps are checked also when relative,
`destination`, `template`, the scratch disk keys and `from`/`to` count as file keys there, and string lists under
`paths`/`files` (top level and nested) are refused outside `/work` and rewritten to absolute paths. Strings in a list
under a file key (also nested lists, e.g. `listing: [[path, size]]`) are checked like the key's own value.

## Inline exports

An export without a destination answers JSON with the file in `dataBase64` (or `pngBase64`, or a key from
`base64Keys`/`base64Formats`). The bridge writes it into `/work` with the extension of its `format` and answers the
`path` instead. A `format` outside the known export formats
(`EXT_BY_FORMAT` in `server.mjs`) or an answer that does not parse is dropped and the call fails: file bytes never
reach the bot inline. A format taken from `base64Formats` (no `format` in the answer) is checked against the leading
bytes of the file when the bridge knows them (`pdf`, `png`, `pptx`; `MAGIC_BY_FORMAT`): one key can carry several
formats (GridCraft's `base64` is a PDF from `file.exportPdf`, an XLSX or CSV from `file.saveBytes`), so bytes of
another format are dropped and the call fails instead of saving them under a wrong extension.

## MP3 export

With `"encodeMp3": true` the bridge lists one tool of its own, `encode_mp3 {path, out?, bitrate_kbps?}`, and runs it
without the child: `lame --quiet -b <kbps> <path> <out>` (no shell, the call timeout applies). Both paths go through
the same `/work` check as every other argument; `out` defaults to the source's name with `.mp3` next to it, must end
with `.mp3` and differ from `path`. The answer is `{path, bytes}`; a failed encode removes the partial file and
answers `lame`'s message. `CRAFT_LAME_BIN` overrides the binary (the tests use `test/fake-lame.mjs`).

## Sessions

Each MCP session has its own `<app>-cli` child. A session closes after `SESSION_IDLE_MINUTES` (default 30, the
manifests' `idleMinutes`); a failed `initialize` leaves no child behind. Beyond `MAX_SESSIONS` (default 4) the least
recently used session is closed with its unsaved document; that is logged, and its client gets HTTP 404 with a
message telling it to initialize again and reopen its last saved file.

## New Craft plugin

1. Pick the release: the newest non-prerelease on `https://github.com/storytold/<app>/releases`. Download its `.deb`
   once, extract `./usr/bin/<app>-cli` (`dpkg-deb --fsys-tarfile <deb> | tar -x ./usr/bin/<app>-cli`), check
   `ldd` (libraries beyond libc go to `aptPackages`; never X11/Wayland — the headless engine renders on the CPU),
   and run `<app>-cli mcp --automation-read-root /tmp/w --automation-write-root /tmp/w` to see its tools (when it
   answers "unknown mcp option", the engine has no roots: run `<app>-cli mcp` and set `"engineRoots": false`;
   when the engine hides tools behind flags, list them in `mcpArgs`).
2. `mkdir <app>` and write `<app>/craft.json` (the checksums from `SHA256SUMS.txt`).
3. `node craft-common/sync.mjs` — writes `server.mjs`, `meminfo.c`, `package.json`, `package-lock.json` and
   `Dockerfile` into `<app>/`.
4. Write `<app>/workmux-plugin.json` (slug `<app>`, description, step-by-step `instructions`: upload to `/work` →
   `doc_open` → `command_list {"filter": ...}` → `command_run` → `render_preview` → `doc_export` →
   `plugin_download_file`; `files.accepts/returns`, `resources`, `idleMinutes`) and `<app>/README.md`; take
   [`photocraft/`](../photocraft/) as the model.
5. Add the folder to the tree and a row to the table in the root [README.md](../README.md).
6. `node .claude/scripts/plugin-gate.mjs validate <app>` and `node .claude/scripts/plugin-gate.mjs docker <app>`.

## Changing the shared code

Edit the files in `craft-common/`, run `node craft-common/sync.mjs` and commit `craft-common/` together with the
regenerated files of every Craft plugin. Never edit a generated file in a plugin folder: the gate refuses it. A
version bump of one plugin is a change of its `craft.json` followed by the same sync.

The bridge tests run `server.mjs` against a fake CLI (`test/fake-cli.mjs`) and a fake `lame` (`test/fake-lame.mjs`;
`test/` is not copied into the plugins):

```bash
npm ci --prefix craft-common
node --test craft-common/test/bridge.test.mjs
```
