# AniCraft — WorkMux plugin

[AniCraft](https://getartcraft.com/apps/anicraft) is an open-source 2D vector animation app in the style of
Flash/Animate, written in Rust, one of the [ArtCraft](https://getartcraft.com/apps) applications
([source](https://github.com/storytold/anicraft)). This plugin runs its headless engine (`anicraft-cli mcp`) in a
container and exposes it to WorkMux bots as a streamable HTTP MCP server. Bots see the tools as `anicraft__<tool>`.

The plugin is built from the shared Craft base in [`craft-common/`](../craft-common/): `server.mjs`, `meminfo.c`,
`package.json`, `package-lock.json` and `Dockerfile` here are generated — edit `craft.json` or `craft-common/` and run
`node craft-common/sync.mjs` instead.

## What a bot can do

Draw shapes and paths, build symbols, add keyframes, motion and shape tweens on a timeline with layers and scenes,
import SVG, PNG, JPEG and sound (WAV, OGG, MP3) — every menu action of the desktop app is an engine command — render
PNG frames and export animated GIF, MP4 and WebM, Lottie JSON, SVG and PNG frames, PNG sequences, sprite sheets and
HTML. All files live in `/work`, the container's working directory; results are handed to the user with
`plugin_download_file`.

Tools (from `anicraft-cli mcp`):

| Tool | What it does |
| --- | --- |
| `anicraft_commands` | find engine commands by `filter` (e.g. `draw.ellipse`, `timeline.create_motion_tween`, `motion.set_key`, `file.export_gif`), with their parameter docs |
| `anicraft_run` | run one engine command: `{"command": ..., "params": {...}}` |
| `anicraft_run_script` | run several commands in order: `{"steps": [{"command": ..., "params": {...}}, ...]}` |
| `anicraft_document` | the open document with its layers and frames |
| `anicraft_render` | PNG of a frame, saved into `/work` (the path is returned) |

Typical session ("animate a bouncing ball for 3 s, return a GIF"):

1. `anicraft__anicraft_run_script` with the steps
   `file.new {"width": 400, "height": 400, "fps": 24}`,
   `draw.ellipse {"x": 170, "y": 20, "w": 60, "h": 60, "fill": "#e53935"}`,
   `timeline.insert_frame {"frame": 71}` (72 frames = 3 s),
   `timeline.create_motion_tween {"frame": 0}` and
   `motion.set_key {"property": "y", "value": ..., "frame": ...}` for frames 0, 18, 36, 54 and 71.
2. `anicraft__anicraft_render {"frame": 18}` → `/work/anicraft_render-<time>.png`.
3. `anicraft__anicraft_run {"command": "file.export_gif", "params": {"path": "/work/ball.gif"}}` →
   `{"frames": 72, "written": "/work/ball.gif"}`; then `plugin_download_file`.

Frames in params are 0-based. A command that would overwrite a file or drop unsaved work is refused without
`"confirm": true`; the instructions tell the bot to use a new file name for every export. SVG is brought in with
`file.import` (into the open document); `file.open` reads `.anicraft` projects only. `file.export_svg` writes one
frame.

## How it works

`server.mjs` (Node 22, `@modelcontextprotocol/sdk`) listens on `0.0.0.0:8080/mcp`:

- **One AniCraft process per MCP session.** `initialize` starts `anicraft-cli mcp` (cwd `/work`) over stdio; the
  session's `Mcp-Session-Id` maps to it. Closing the session (`DELETE`, idle timeout, SIGTERM) kills the process.
  An unknown session id gets HTTP 404 so the client re-initializes. A new session has an empty document only — the
  instructions tell the bot to save `.anicraft` files (`file.save_as`) and reopen them with `file.open`.
- **tools/list, tools/call and resources are forwarded** to AniCraft (its own tool list and server instructions,
  with a WorkMux note on top).
- **Paths stay in `/work`.** AniCraft has no automation roots of its own (`"engineRoots": false` in `craft.json`; it
  writes wherever it is told), so the bridge is the only fence: top-level `path`-like arguments are resolved against
  `/work`, file keys inside `anicraft_run` params and `anicraft_run_script` steps (`path`, `dir`, …) are refused
  outside `/work` also when relative, and any other value that looks like a path (absolute, or going up with `..`) is
  checked as well; symlinks out of `/work` are refused too.
- **No inline files.** The PNG of `anicraft_render` is saved into `/work` and replaced by its path.
- **Timeouts.** Each call is limited to `CRAFT_CALL_TIMEOUT_MS` (default from `craft.json`, 600 s, for long
  exports); startup to `CRAFT_START_TIMEOUT_MS` (default 30 s).
- `GET /healthz` returns 200; SIGTERM closes all sessions and exits within a few seconds.

`file.export_video` (MP4, WebM) encodes with `ffmpeg`, which the image installs from Debian (`aptPackages` in
`craft.json`). Rendering runs on the CPU, so no GPU is needed. The preloaded `meminfo.c` shim caps `MemTotal` in
`/proc/meminfo` by the container's memory limit ([details](../craft-common/README.md#working-memory-in-a-container)).

## Version

AniCraft **0.2.1**, pinned in `craft.json` with the SHA-256 of the release `.deb` (amd64 and arm64); the generated
`Dockerfile` carries them as `ARG` defaults. Only `anicraft-cli` and its licence files are extracted from the
package; the desktop app and its X11/Wayland/GPU libraries are not installed. To update, change `version` and both
checksums in `craft.json` from the release's `SHA256SUMS.txt` (no `-rc` releases) and run `node craft-common/sync.mjs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory tools may read and write |
| `CRAFT_CLI` | `anicraft-cli` | the AniCraft CLI |
| `CRAFT_CALL_TIMEOUT_MS` | `600000` | per tool call |
| `CRAFT_START_TIMEOUT_MS` | `30000` | start of an AniCraft process |
| `SESSION_IDLE_MINUTES` | `30` | close an MCP session after this much inactivity (the manifest's `idleMinutes`) |
| `MAX_SESSIONS` | `4` | AniCraft processes at once; the least recently used is closed beyond it (logged; its client gets a 404 that says so) |
| `ANICRAFT_*` | — | passed to `anicraft-cli` |

## Run locally

```sh
docker build -t workmux-plugin-anicraft anicraft
docker run --rm -p 8080:8080 workmux-plugin-anicraft
curl http://localhost:8080/healthz
```

Then point any MCP client with streamable HTTP at `http://localhost:8080/mcp`.

## License

This wrapper is MIT (see the repository's `LICENSE`). AniCraft itself is MIT/Apache-2.0; its licence files are in
the image under `/usr/share/doc/anicraft`.
