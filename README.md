# workmux-tools

Tool containers for [WorkMux](https://app.workmux.com). A tool is a Docker image with an MCP server inside;
WorkMux builds it, starts one container per conversation thread and gives the project's bots its tools as
`<slug>__<tool>`.

## Structure: one folder = one tool

```
workmux-tools/
├── solidcraft/            SolidCraft CAD — headless parametric 3D CAD (STL/STEP export, renders)
│   ├── workmux-tool.json  manifest
│   ├── Dockerfile
│   ├── server.mjs         MCP server
│   ├── package.json
│   └── README.md
├── gws/                   Google Workspace — Drive, Sheets, Docs, Gmail, Calendar… through the gws CLI
└── <your-tool>/ ...
```

| Tool | What it does |
| --- | --- |
| [`solidcraft`](solidcraft/) | [SolidCraft](https://solidcraft.io) parametric CAD: design parts, measure, render PNG, export STL/STEP/3MF/GLB |
| [`gws`](gws/) | Google Workspace through the [Google Workspace CLI](https://github.com/googleworkspace/cli): Drive, Sheets, Docs, Slides, Gmail, Calendar, Tasks, Chat… Generic `run` / `schema` / `help` tools; auth by a WorkMux OAuth token, an access token or a service account key (all optional secrets) |

## Add a tool to WorkMux

In WorkMux open **Project settings → Tools → Add from repository** and fill in:

- **Repository URL:** `https://github.com/killov/workmux-tools.git`
- **Subdirectory:** the tool's folder, e.g. `solidcraft`

or let a bot do it with the MCP tool `project_tool_create`:

```json
{ "repoUrl": "https://github.com/killov/workmux-tools.git", "path": "solidcraft" }
```

WorkMux reads `workmux-tool.json` in that folder, builds the image and the tool is ready for the project's bots.

## Write your own tool

Create a folder with a `workmux-tool.json`, a `Dockerfile` and the MCP server. The manifest is validated against
[`https://app.workmux.com/schemas/workmux-tool.v1.json`](https://app.workmux.com/schemas/workmux-tool.v1.json):

```json
{
  "$schema": "https://app.workmux.com/schemas/workmux-tool.v1.json",
  "version": 1,
  "slug": "my-tool",
  "name": "My Tool",
  "description": "What it does, for people and bots.",
  "instructions": "1. Upload the input to /work ...\n2. Call ...\n3. Download the result with tool_download_file.",
  "build": { "dockerfile": "Dockerfile", "context": "." },
  "mcp": { "port": 8080, "path": "/mcp" },
  "resources": { "memoryMb": 1024, "cpus": 1 },
  "idleMinutes": 30,
  "files": {
    "accepts": [{ "type": "csv", "description": "Input data" }],
    "returns": [{ "type": "png", "description": "Rendered chart" }]
  }
}
```

Secrets are declared by name only (`"secrets": [{ "env": "API_KEY", "description": "...", "required": false }]`);
their values are picked from the project's passwords in WorkMux. A required secret (the default) blocks the build
until it is set, so mark secrets the tool can start without as `"required": false`. Never put secrets into this repository — it is public.

### The contract

The container must:

1. **Serve MCP over streamable HTTP** on `0.0.0.0:<mcp.port><mcp.path>` (e.g. `0.0.0.0:8080/mcp`), not on
   localhost. Sessions are stateful through the `Mcp-Session-Id` header; a request with an unknown session id
   answers **HTTP 404**, so the client initializes again.
2. **Answer `GET /healthz` with 200** and declare a `HEALTHCHECK` in the Dockerfile.
3. **Work in `/work`:** `WORKDIR /work`, owned by a non-root user (e.g. `USER node` in Node images).
4. **Take and return file paths in `/work`, never file contents or base64.** A tool that produces an image or a
   file writes it into `/work` and returns the path; the bot hands it to the user with `tool_download_file`. Inputs
   the user gives are uploaded to `/work` and passed by path.
5. **Start fast:** answer `initialize` and `tools/list` within a minute of the container start.
6. **Stop cleanly:** on SIGTERM close sessions and exit within a few seconds.
7. **Keep tool names short:** `<slug>__<tool>` has at most 64 characters, letters, digits, `_` and `-`.

The container belongs to one conversation thread and is deleted, with `/work`, after `idleMinutes` of inactivity —
tell the bot in `instructions` to download results it needs.

[`solidcraft/`](solidcraft/) is a complete example: a Node 22 server (`@modelcontextprotocol/sdk`) that wraps a
stdio MCP server, confines paths to `/work` and turns inline images into files. [`gws/`](gws/) shows how to wrap a
plain CLI with a few generic tools and optional credentials.

## License

[MIT](LICENSE)
