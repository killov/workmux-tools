# workmux-tools — conventions for agents

Public repository of WorkMux plugins: Docker images with an MCP server inside. WorkMux builds a folder
of this repository, starts one container per conversation thread and gives bots its tools as `<slug>__<tool>`.
The container contract is in [README.md](README.md#the-contract) — read it before touching a plugin.

## One folder = one plugin

- Each top-level folder is one plugin: `workmux-plugin.json` (manifest, `$schema`
  `https://app.workmux.com/schemas/workmux-plugin.v1.json`), `Dockerfile`, the MCP server (`server.mjs` on Node 22 +
  `@modelcontextprotocol/sdk`), `package.json` + `package-lock.json`, `README.md`. `workmux-tool.json` is a legacy
  name the server still reads; new and renamed plugins use `workmux-plugin.json`.
- The build context is the plugin's folder only; no code shared between folders.
- `slug` = folder name. Tool names are short `snake_case`; `<slug>__<tool>` has at most 64 characters.
- Patterns to reuse: [`solidcraft/`](solidcraft/) (wraps a stdio MCP server, confines paths to `/work`, turns inline
  images into files), [`gws/`](gws/) (wraps a CLI with a few generic tools, optional secrets, OAuth header).

## Builds are pinned

- Every downloaded binary or release archive is pinned to a version (`ARG X_VERSION=...`) and verified with
  `sha256sum -c` per architecture (`TARGETARCH` amd64/arm64), see `gws/Dockerfile`.
- npm dependencies install with `npm ci` from the committed lockfile; no `latest` tags.
- Multi-stage builds: toolchains stay out of the runtime stage; `apt-get install --no-install-recommends` and remove
  the apt lists.

## Runtime rules (short version of the contract)

- MCP over streamable HTTP on `0.0.0.0:<mcp.port><mcp.path>`; an unknown `Mcp-Session-Id` answers HTTP 404.
- `GET /healthz` answers 200 and the Dockerfile declares a `HEALTHCHECK`.
- `WORKDIR /work` owned by a non-root user; the last `USER` is not root.
- Files in and out are paths in `/work` — never contents or base64; paths outside `/work` are refused.
- Answers `initialize` / `tools/list` within a minute; exits within a few seconds on SIGTERM (`tini`).
- Secrets are declared by name only (`"required": false` when the plugin starts without them). The repository is
  public: never commit a secret value, never log or return one.
- `instructions` in the manifest is the bot's step-by-step guide: upload the input to `/work`, call the tools,
  hand the result over with `plugin_download_file`.

## README table

Adding or renaming a plugin updates the root [README.md](README.md): the folder tree under "Structure" and a row
`| [\`<slug>\`](<slug>/) | what it does |` in the table. The plugin's own `README.md` lists its tools.

## Checks

```bash
npm ci --prefix .claude/scripts                       # once
node .claude/scripts/plugin-gate.mjs validate [dir]   # manifest vs. schema + the conventions above
node .claude/scripts/plugin-gate.mjs docker <dir>     # docker build → run → MCP smoke (needs docker)
node .claude/scripts/plugin-gate.mjs smoke <mcp-url>  # MCP smoke against a running container
node .claude/scripts/plugin-qa.mjs                    # sample task through the plugin's MCP (help)
```

## Git

Work on a task branch from `master`; commit messages are short, imperative, with the task id (`... - WOR-123`).
