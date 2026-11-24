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

## New Craft plugin

1. Pick the release: the newest non-prerelease on `https://github.com/storytold/<app>/releases`. Download its `.deb`
   once, extract `./usr/bin/<app>-cli` (`dpkg-deb --fsys-tarfile <deb> | tar -x ./usr/bin/<app>-cli`), check
   `ldd` (libraries beyond libc go to `aptPackages`; never X11/Wayland — the headless engine renders on the CPU),
   and run `<app>-cli mcp --automation-read-root /tmp/w --automation-write-root /tmp/w` to see its tools.
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
