# Google Workspace (gws) — WorkMux tool

Google Workspace APIs for WorkMux bots through the [Google Workspace CLI](https://github.com/googleworkspace/cli)
(`gws`): Drive, Sheets, Docs, Slides, Gmail, Calendar, Tasks, People, Chat, Forms, Meet, Keep, Classroom, Apps
Script. Bots see the tools as `gws__<tool>`.

`gws` has no MCP mode — `gws mcp` existed in early releases and was removed in 0.8.0 (changelog: *“Remove `mcp`
command”*). This tool wraps the CLI in a small MCP server with a few generic tools instead of one tool per API
method, so the bot's context stays small and every API `gws` knows is reachable.

## Tools

| Tool | What it does |
| --- | --- |
| `run` | `gws <args...>` without a shell. `args` is an array of strings; returns `{exit_code, stdout, stderr}` with stdout parsed as JSON when it is JSON. Output over 64 KB is written to `/work/gws-run-<time>.out` and only its path and a preview are returned. Optional `timeout_seconds` (default 120, max 600). |
| `schema` | `gws schema <service.resource.method>` — HTTP verb, parameters (`--params`) and body (`--json`) of a method. No credentials needed. |
| `help` | `gws [command...] --help` — services, resources, methods, `+` helpers and their flags. No credentials needed. |
| `auth_status` | Which credentials the next call uses (never the secret) and, for a service account, its e-mail. |

Examples of `run` args:

```json
["drive", "files", "list", "--params", "{\"pageSize\": 10, \"q\": \"trashed=false\"}"]
["sheets", "+read", "--spreadsheet", "ID", "--range", "Sheet1!A1:D10"]
["sheets", "+append", "--spreadsheet", "ID", "--values", "Alice,95"]
["docs", "documents", "get", "--params", "{\"documentId\": \"ID\"}"]
["calendar", "+agenda", "--week"]
["gmail", "users", "messages", "list", "--params", "{\"userId\": \"me\", \"q\": \"is:unread\"}"]
["gmail", "+send", "--to", "a@example.com", "--subject", "Hi", "--body", "Text", "--attach", "/work/report.pdf"]
["drive", "files", "get", "--params", "{\"fileId\": \"ID\", \"alt\": \"media\"}", "--output", "/work/report.pdf"]
["drive", "+upload", "/work/report.pdf", "--name", "Report"]
```

## Files

Everything goes through `/work`. File flags — `--upload`, `--output`, `--output-dir`, `--attach`/`-a`, `--dir`
and the file of `drive +upload` — must point into `/work`; relative paths resolve against it and paths outside
(also through symlinks) are refused. `gws` runs with `/work` as its working directory and refuses upload/output
paths outside it itself, too. The bot brings files in with `tool_upload_file` and hands results over with
`tool_download_file`.

`gws` reads a `.env` file from its working directory; if `/work/.env` exists, the tools refuse to run and ask to
rename it, so an uploaded file cannot reconfigure the CLI.

## Credentials

Decided for every call, first match wins:

1. **`x-workmux-oauth-token` HTTP header** on the MCP request — an OAuth access token WorkMux sends from the
   project's OAuth connection. Passed to `gws` as `GOOGLE_WORKSPACE_CLI_TOKEN` for that call only. The tool acts as
   the connected Google user (Gmail, their Drive and Calendar).
2. **`GOOGLE_WORKSPACE_CLI_TOKEN`** env/secret — an OAuth2 access token (expires after about an hour).
3. **`GOOGLE_SERVICE_ACCOUNT_JSON`** secret — the service account key JSON. At start it is written to
   `~/.workmux-gws/service-account.json` (mode 600, outside `/work`) and passed as
   `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`. The tool acts as the service account itself: it sees only what is shared
   with its e-mail and has no Gmail mailbox (gws 0.7.0 removed domain-wide delegation / impersonation).
4. **`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`** — a credentials file already present in the container.

Without any of them `run` answers with an explanation of what to set; `help`, `schema` and `run ... --dry-run`
still work. Tokens and keys are never logged or returned: `gws` gets a minimal environment, and output is scrubbed
of the token in use, of anything that looks like a Google access token (`ya29.…`) and of PEM private keys.

Both secrets are declared in `workmux-tool.json` with `"required": false`, so the tool builds and starts without
them.

## Disabled commands

- `gws auth login | setup | export | logout` — need a browser or gcloud, store or print credentials; credentials
  come from WorkMux instead. `gws auth status` works.
- `gmail +watch` and `events +subscribe` without `--once` — they stream forever.
- `script +push` without `--dir` (it would push the whole working directory).

## Version

gws **0.22.5** (latest stable release), static musl binaries for amd64 and arm64 pinned in the `Dockerfile` with
their SHA-256 from the release's `.sha256` files. To update, change `GWS_VERSION` and both checksums.

Known gws issue: `schema ... --resolve-refs` crashes (SIGSEGV) on recursive schemas such as
`gmail.users.messages.send`; the tool reports it and suggests calling `schema` without `resolve_refs`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/work` | the only directory for files |
| `GWS_BIN` | `/usr/local/bin/gws` | the CLI |
| `GWS_TIMEOUT_SECONDS` | `120` | default timeout of `run` |
| `GWS_MAX_TIMEOUT_SECONDS` | `600` | maximum `timeout_seconds` |
| `GWS_INLINE_LIMIT_BYTES` | `65536` | stdout above this goes to a file in `/work` |
| `GOOGLE_WORKSPACE_PROJECT_ID` | — | GCP project for quota and billing, passed to gws |

## Run locally

```sh
docker build -t workmux-tool-gws gws
docker run --rm -p 8080:8080 -e GOOGLE_WORKSPACE_CLI_TOKEN="$(gcloud auth print-access-token)" workmux-tool-gws
```

## License

This wrapper is MIT (see the repository's `LICENSE`); gws is Apache-2.0, its licence is in the image under
`/usr/share/doc/gws`.
