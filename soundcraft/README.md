# SoundCraft — WorkMux plugin

[SoundCraft](https://getartcraft.com/apps/soundcraft) is an open-source digital audio workstation written in Rust, one
of the [ArtCraft](https://getartcraft.com/apps) applications ([source](https://github.com/storytold/soundcraft)). This
plugin runs its headless engine (`soundcraft-cli mcp`) in a container and exposes it to WorkMux bots as a streamable
HTTP MCP server. Bots see the tools as `soundcraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Import audio (WAV, MP3, FLAC, OGG, AIFF…) onto tracks, edit clips — strip silence, trim, separate, move, fades, clip
gain — and mix tracks with volume, pan, the built-in EQ, dynamics and reverb plugins and automation; every menu action
of the desktop app is an engine command (480+). The mix is bounced to WAV or FLAC with optional peak normalization and
encoded to MP3. All files live in `/work`, the container's working directory; results are handed to the user with
`plugin_download_file`.

Tools (from `soundcraft-cli mcp`, plus `encode_mp3` of the bridge):

| Tool | What it does |
| --- | --- |
| `import_audio` | import a file from `/work` onto a new or given track (`track`, `at`); returns the track and clip ids |
| `list_commands` | find engine commands by `filter` (e.g. `edit.strip_silence`, `edit.move_clips`, `edit.fades_create`), with their parameters |
| `execute`, `batch` | run one or several engine commands |
| `inspect_session` | tracks, clips (id, start, length, end), mixer, automation, markers, selection |
| `new_session`, `open_session`, `save_session` | start an empty session, open or save a `.scraft` session in `/work` |
| `bounce_mix` | render the mix (`start`, `end`) to WAV/AIFF/FLAC in `/work`, 16/24-bit or 32-bit float, `normalize` peaks it at -0.1 dBFS; returns seconds, peak and LUFS |
| `encode_mp3` | encode a WAV from `/work` to MP3 with `lame` (`bitrate_kbps`, default 192) — added by the bridge, see below |
| `parity` | the engine's feature parity report |

The `APP_ONLY` tools (`screenshot`, `ui_inspect`, `ui_set`, `menu_invoke`, `click`, `drag`, `key`) drive the desktop
app and are not listed.

Typical session ("strip the silence at the start, normalize the loudness and return an MP3"):

1. Upload `in.wav` to `/work`; `soundcraft__import_audio {"path": "/work/in.wav"}`.
2. `soundcraft__execute {"command": "edit.select_all"}`, then
   `soundcraft__execute {"command": "edit.strip_silence", "params": {"threshold_db": -48}}`.
3. `soundcraft__inspect_session {"detail": "full"}` → the clip's `id` and `length`; the clip still starts where the
   sound began, so `soundcraft__execute {"command": "edit.move_clips", "params": {"clips": [<id>], "to": 0}}`.
4. `soundcraft__bounce_mix {"path": "/work/out.wav", "normalize": true, "bit_depth": "16", "start": 0, "end": <length>}`.
5. `soundcraft__encode_mp3 {"path": "/work/out.wav", "out": "/work/out.mp3"}`, then `plugin_download_file`.

`bounce_mix` without `end` renders the whole session length, so the stripped silence would come back at the end.
Positions are samples of the session (48 kHz; imports are resampled) or `{"seconds": x}`.

## MP3

SoundCraft bounces WAV, AIFF and FLAC only. With `"encodeMp3": true` in `craft.json` the bridge adds the
`encode_mp3` tool and runs `lame` (from Debian) on a WAV in `/work` itself: both paths are confined to `/work`
(also through symlinks), the target must end with `.mp3` and differ from the source, and a failed encode leaves no
partial file behind. The default target is the source's name with `.mp3` next to it.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One SoundCraft process per MCP session.** `initialize` starts
  `soundcraft-cli mcp --automation-read-root /work --automation-write-root /work` (cwd `/work`) over stdio; the
  session's `Mcp-Session-Id` maps to it. Closing the session (`DELETE`, idle timeout, SIGTERM) kills the process.
  An unknown session id gets HTTP 404 so the client re-initializes. A new session is empty — the instructions tell
  the bot to save `.scraft` sessions and reopen them with `open_session`.
- **tools/list, tools/call and resources are forwarded** to SoundCraft (its own tool list and server instructions,
  with a WorkMux note on top), except `encode_mp3`, which the bridge runs itself.
- **Paths stay in `/work`.** The engine confines its files to `/work` itself, and the bridge checks every path-like
  argument first (top level and inside `execute` params and `batch` calls; symlinks out of `/work` are refused).
- **No inline files.** Audio or images in the engine's answers are saved into `/work` and replaced by their paths.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 300 s); startup to
  `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

Mixing and bouncing run on the CPU; there is no audio device in the container, so recording from an input is not
available. The preloaded `meminfo.c` shim caps `MemTotal` in `/proc/meminfo` by the container's memory limit
([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

SoundCraft **0.20.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `soundcraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `soundcraft-cli` | the SoundCraft CLI |
| `CRAFT_LAME_BIN` | `lame` | the MP3 encoder of `encode_mp3` |
| `CRAFT_CALL_TIMEOUT_MS` | `300000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of a SoundCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | SoundCraft processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `SOUNDCRAFT_*` | — | passed to `soundcraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-soundcraft soundcraft
docker run --rm -p 8080:8080 workmux-plugin-soundcraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). SoundCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/soundcraft`. `lame` is LGPL and comes from Debian.
