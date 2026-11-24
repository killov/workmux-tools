@AGENTS.md

## /resolve

Tasks in this repository are solved with `/resolve` (`.claude/commands/resolve.md`): the Workflow
`.claude/workflows/resolve.js` runs Zdena-ARCH → Zdena-DEV → GATE → Zdena-CR → Zdena-QA until CR approves and QA passes.

- **GATE** = `.claude/scripts/plugin-gate.mjs`: changed plugin folders + `pluginVersion` bump vs. base, manifest
  vs. schema and the conventions above, `docker build` + run + MCP smoke (`initialize`, `tools/list`, 404 on an unknown session). Without a
  Docker daemon the container is built with the `workmux` MCP tool `run_session_container` and `smoke` runs
  against it.
- **QA** = `.claude/scripts/plugin-qa.mjs`: a sample task from the task's acceptance through the plugin's MCP —
  upload an input to `/work`, call the tools, download and check the output file.
- A WorkMux worker in auto mode follows `.claude/commands/resolve-tasks.md` (never asks, ends with `task_done` /
  `needs_attention` / `task_wait`). `/resolve-watchdog` restarts a Workflow run that died without a verdict.
- Agents (`.claude/agents/Zdena-*.md`) talk Czech; code, manifests and READMEs stay English (public repo).
