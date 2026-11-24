// WorkMux plugin: Google Workspace CLI (gws) behind a streamable HTTP MCP endpoint.
//
// gws has no MCP mode (`gws mcp` was removed in 0.8.0), so this server exposes a few generic tools
// instead of one tool per API method:
//   run          gws <args...> without a shell; big output and downloads go to files in /work
//   schema       gws schema <service.resource.method>
//   help         gws <service> [resource] [method] --help
//   auth_status  which credentials the next call would use (never the secret itself)
//
// Credentials, first match wins, decided per call:
//   1. HTTP header x-workmux-oauth-token on the MCP request -> GOOGLE_WORKSPACE_CLI_TOKEN
//   2. env GOOGLE_WORKSPACE_CLI_TOKEN
//   3. env GOOGLE_SERVICE_ACCOUNT_JSON (key JSON) -> 0600 file outside /work -> GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE
//   4. env GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE (a file already in the image or mounted)
// Tokens and keys are never logged or returned; outputs are scrubbed of them.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------------------------
// Configuration

const env = process.env;
const WORK_DIR = path.resolve(env.WORK_DIR || "/work");
const GWS = env.GWS_BIN || "gws";
const HOST = env.HOST || "0.0.0.0";
const PORT = Number(env.PORT || 8080);
const MCP_PATH = env.MCP_PATH || "/mcp";
const VERSION = "0.1.0";
const DEFAULT_TIMEOUT_S = Number(env.GWS_TIMEOUT_SECONDS || 120);
const MAX_TIMEOUT_S = Number(env.GWS_MAX_TIMEOUT_SECONDS || 600);
const INLINE_LIMIT = Number(env.GWS_INLINE_LIMIT_BYTES || 64 * 1024);
const STDERR_LIMIT = 16 * 1024;
const SESSION_IDLE_MS = Number(env.SESSION_IDLE_MINUTES || 60) * 60_000;
const MAX_SESSIONS = Number(env.MAX_SESSIONS || 16);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TOKEN_HEADER = "x-workmux-oauth-token";

// Private state lives outside /work (which the bot can read and download).
const STATE_DIR = path.resolve(env.GWS_STATE_DIR || path.join(os.homedir(), ".workmux-gws"));
const CONFIG_DIR = path.join(STATE_DIR, "config"); // gws config + discovery cache
const SA_FILE = path.join(STATE_DIR, "service-account.json");

// Flags whose value is a local file or directory.
const PATH_FLAGS = new Set(["--upload", "--output", "--output-dir", "--attach", "-a", "--dir"]);

const log = (...args) => console.error(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------------------------
// Credentials

let serviceAccount = null; // { file, email }
function prepareServiceAccount() {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON; ignoring it");
    return;
  }
  fs.writeFileSync(SA_FILE, raw, { mode: 0o600 });
  fs.chmodSync(SA_FILE, 0o600);
  serviceAccount = { file: SA_FILE, email: parsed.client_email || null, type: parsed.type || null };
  log(`service account key written outside ${WORK_DIR} (${serviceAccount.email || "no client_email"})`);
}

function headerToken(extra) {
  let v = extra?.requestInfo?.headers?.[TOKEN_HEADER];
  if (Array.isArray(v)) v = v[0];
  if (typeof v !== "string") return null;
  v = v.trim().replace(/^Bearer\s+/i, "");
  return v || null;
}

// The credentials for one call: env for the child, a label, and secrets to scrub from output.
function resolveAuth(extra) {
  const h = headerToken(extra);
  if (h) return { source: "header", env: { GOOGLE_WORKSPACE_CLI_TOKEN: h }, secrets: [h] };
  if (env.GOOGLE_WORKSPACE_CLI_TOKEN) return { source: "env-token", env: { GOOGLE_WORKSPACE_CLI_TOKEN: env.GOOGLE_WORKSPACE_CLI_TOKEN }, secrets: [env.GOOGLE_WORKSPACE_CLI_TOKEN] };
  if (serviceAccount) return { source: "service-account", env: { GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: serviceAccount.file }, secrets: [] };
  if (env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) return { source: "credentials-file", env: { GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE }, secrets: [] };
  return null;
}

const SOURCE_TEXT = {
  header: `the OAuth access token WorkMux sent with this request (${TOKEN_HEADER} header)`,
  "env-token": "the access token in GOOGLE_WORKSPACE_CLI_TOKEN",
  "service-account": "the service account key from GOOGLE_SERVICE_ACCOUNT_JSON",
  "credentials-file": "the credentials file in GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE",
};

const NO_AUTH_TEXT = [
  "No Google credentials are configured for this plugin, so gws cannot call Google APIs.",
  "Ask the project owner to set one of these in WorkMux (Project settings → Plugins → Google Workspace):",
  `- an OAuth connection whose access token WorkMux passes in the ${TOKEN_HEADER} header (preferred; acts as the connected Google user),`,
  "- the env/secret GOOGLE_WORKSPACE_CLI_TOKEN with an OAuth2 access token (expires after about an hour),",
  "- the secret GOOGLE_SERVICE_ACCOUNT_JSON with a service account key JSON (acts as the service account itself: it sees only files and calendars shared with its e-mail; it cannot read anyone's Gmail).",
  "Without credentials you can still use help, schema and run with --dry-run.",
].join("\n");

const SECRET_RE = /\bya29\.[A-Za-z0-9._-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
function scrub(text, secrets) {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out.replace(SECRET_RE, "[redacted]");
}

// ---------------------------------------------------------------------------------------------
// Paths

class ToolError extends Error {}

function isInside(dir, p) {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveInWork(value, what) {
  if (typeof value !== "string" || value.trim() === "") throw new ToolError(`${what} needs a path inside ${WORK_DIR}`);
  const abs = path.resolve(WORK_DIR, value);
  if (!isInside(WORK_DIR, abs)) throw new ToolError(`${what} ${JSON.stringify(value)} is outside ${WORK_DIR}; files must be in ${WORK_DIR} (upload them there first, download results from there)`);
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== WORK_DIR) probe = path.dirname(probe);
  let real = probe;
  try {
    real = fs.realpathSync(probe);
  } catch {}
  if (!isInside(fs.realpathSync(WORK_DIR), real)) throw new ToolError(`${what} ${JSON.stringify(value)} leads outside ${WORK_DIR} through a symlink`);
  return abs;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "") + "-" + randomUUID().slice(0, 4);
}

// ---------------------------------------------------------------------------------------------
// Argument checks

function checkArgs(input) {
  if (!Array.isArray(input) || input.length === 0) throw new ToolError('args must be a non-empty array of strings, e.g. ["drive", "files", "list", "--params", "{\\"pageSize\\": 10}"]');
  if (input.length > 500) throw new ToolError("too many arguments (max 500)");
  let args = input.map((a, i) => {
    if (typeof a !== "string") throw new ToolError(`args[${i}] must be a string (pass JSON for --params/--json as one string)`);
    if (a.includes("\0")) throw new ToolError(`args[${i}] contains a NUL byte`);
    return a;
  });
  if (args[0] === "gws") args = args.slice(1);
  if (args.length === 0) throw new ToolError("args has only \"gws\"; add the service and method, e.g. [\"drive\", \"files\", \"list\"]");

  const words = args.filter((a) => !a.startsWith("-"));
  const isHelp = args.includes("--help") || args.includes("-h") || words[0] === "help";

  // Commands that make no sense in a throwaway container or would store/print credentials.
  if (words[0] === "auth" && !isHelp) {
    const sub = words[1];
    if (["login", "setup", "export", "logout"].includes(sub)) {
      throw new ToolError(
        `gws auth ${sub} is disabled in this tool: ` +
          {
            login: "it needs a browser on this machine and would store a refresh token in a container that is deleted after the conversation.",
            setup: "it needs gcloud and creates Google Cloud projects and OAuth clients.",
            export: "it prints decrypted credentials.",
            logout: "there are no stored credentials to clear.",
          }[sub] +
          " Credentials come from WorkMux instead (an OAuth connection, GOOGLE_WORKSPACE_CLI_TOKEN or a service account key); call auth_status to see which one is active.",
      );
    }
  }
  const helper = words.find((w) => w.startsWith("+"));
  if ((helper === "+watch" || helper === "+subscribe") && !isHelp && !args.includes("--once")) {
    throw new ToolError(`${helper} streams forever and would only hit the timeout here. Add "--once" to pull one batch and exit.`);
  }
  if (helper === "+push" && !isHelp && !args.some((a) => a === "--dir" || a.startsWith("--dir="))) {
    throw new ToolError(`script +push needs --dir with a folder in ${WORK_DIR} (the files to push)`);
  }

  // Confine file paths to /work and make them absolute.
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0 && PATH_FLAGS.has(a.slice(0, eq))) {
      out.push(`${a.slice(0, eq)}=${resolveInWork(a.slice(eq + 1), a.slice(0, eq))}`);
    } else if (PATH_FLAGS.has(a) && i + 1 < args.length) {
      out.push(a, resolveInWork(args[++i], a));
    } else {
      out.push(a);
    }
  }
  // drive +upload <file>: the first positional after the helper is a file.
  const up = out.indexOf("+upload");
  if (up >= 0 && !isHelp) {
    for (let i = up + 1; i < out.length; i++) {
      if (out[i].startsWith("-")) {
        if (!out[i].includes("=") && i + 1 < out.length && !out[i + 1].startsWith("-")) i++; // skip flag value
        continue;
      }
      out[i] = resolveInWork(out[i], "+upload file");
      break;
    }
  }
  const needsAuth = !(isHelp || args.includes("--dry-run") || words[0] === "schema" || args[0] === "--version" || args[0] === "-V" || (words[0] === "auth" && words[1] === "status"));
  return { args: out, needsAuth };
}

// ---------------------------------------------------------------------------------------------
// Running gws

const running = new Set();

// gws loads a .env file from its working directory (dotenvy). /work holds user files, so a .env
// there could inject settings; refuse to run instead of silently picking it up.
function checkNoDotenv() {
  if (fs.existsSync(path.join(WORK_DIR, ".env"))) {
    throw new ToolError(`${WORK_DIR}/.env exists; gws would load it as configuration. Rename or delete it (e.g. keep it as env.txt) and call again.`);
  }
}

function childEnv(auth) {
  const e = {
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: os.homedir(),
    LANG: env.LANG || "C.UTF-8",
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: CONFIG_DIR,
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
  };
  for (const k of ["TZ", "GOOGLE_WORKSPACE_PROJECT_ID", "GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE", "GOOGLE_WORKSPACE_CLI_SANITIZE_MODE", "GOOGLE_WORKSPACE_CLI_LOG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE"]) {
    if (env[k] !== undefined) e[k] = env[k];
  }
  return { ...e, ...(auth?.env || {}) };
}

// Run gws; stdout above INLINE_LIMIT is streamed into a file in /work.
function runGws(args, { auth, timeoutS, signal, outName }) {
  return new Promise((resolve) => {
    // cwd is WORK_DIR: gws itself refuses --upload/--output paths outside its working directory.
    const child = spawn(GWS, args, { cwd: WORK_DIR, env: childEnv(auth), stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    const chunks = [];
    let size = 0;
    let file = null;
    let fd = null;
    let stderr = "";
    let timedOut = false;
    let spawnError = null;

    child.stdout.on("data", (c) => {
      size += c.length;
      if (fd === null && size > INLINE_LIMIT) {
        file = path.join(WORK_DIR, `${outName}-${stamp()}.out`);
        fd = fs.openSync(file, "w", 0o644);
        for (const b of chunks) fs.writeSync(fd, b);
        chunks.length = 0;
      }
      if (fd !== null) fs.writeSync(fd, c);
      else chunks.push(c);
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < STDERR_LIMIT * 4) stderr += c.toString("utf8");
    });
    const kill = () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutS * 1000);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort);
    child.on("error", (err) => (spawnError = err));
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      running.delete(child);
      if (fd !== null) fs.closeSync(fd);
      resolve({ code, sig, timedOut, spawnError, stdout: Buffer.concat(chunks).toString("utf8"), stdoutFile: file, stdoutBytes: size, stderr });
    });
  });
}

function formatResult(r, { args, auth, timeoutS }) {
  const secrets = auth?.secrets || [];
  if (r.spawnError) return { content: [{ type: "text", text: `Cannot start gws: ${r.spawnError.message}` }], isError: true };
  if (r.stdoutFile) {
    // Scrub the file too, in case it echoes a token (it normally does not).
    const text = fs.readFileSync(r.stdoutFile, "utf8");
    const clean = scrub(text, secrets);
    if (clean !== text) fs.writeFileSync(r.stdoutFile, clean);
  }
  const out = { exit_code: r.code };
  if (r.sig && !r.timedOut) out.signal = `gws was ended by ${r.sig}${r.sig === "SIGSEGV" ? " (a crash in gws; for schema, try again without resolve_refs)" : ""}`;
  if (r.timedOut) out.timed_out = `gws did not finish within ${timeoutS} s and was stopped; pass timeout_seconds (max ${MAX_TIMEOUT_S}) or narrow the request (--page-limit, fields, pageSize)`;
  if (r.stdoutFile) {
    out.stdout_file = r.stdoutFile;
    out.stdout_bytes = r.stdoutBytes;
    out.stdout_preview = scrub(fs.readFileSync(r.stdoutFile, "utf8").slice(0, 2000), secrets);
    out.note = `The output was larger than ${INLINE_LIMIT} bytes, so it was written to ${r.stdoutFile}. Read parts of it with a narrower request, or download it with plugin_download_file.`;
  } else {
    const text = scrub(r.stdout, secrets);
    let parsed;
    try {
      parsed = text.trim() ? JSON.parse(text) : "";
    } catch {
      parsed = text;
    }
    out.stdout = parsed;
  }
  const err = scrub(r.stderr, secrets).trim();
  if (err) out.stderr = err.length > STDERR_LIMIT ? err.slice(0, STDERR_LIMIT) + "\n…[stderr truncated]" : err;
  for (const flag of ["--output", "--output-dir"]) {
    const i = args.findIndex((a) => a === flag || a.startsWith(flag + "="));
    if (i >= 0) {
      const p = args[i].includes("=") ? args[i].split("=").slice(1).join("=") : args[i + 1];
      if (p && fs.existsSync(p)) out.written = { path: p, bytes: fs.statSync(p).isFile() ? fs.statSync(p).size : undefined, hint: "Download it with plugin_download_file." };
    }
  }
  if (r.code === 2 && auth) out.auth_hint = `Google rejected ${SOURCE_TEXT[auth.source]}. It may be expired, lack the scope this API needs, or (service account) the resource is not shared with it.`;
  const isError = r.code !== 0 || r.timedOut;
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError };
}

// ---------------------------------------------------------------------------------------------
// MCP tools

const INSTRUCTIONS = [
  "Google Workspace through the gws CLI (Drive, Sheets, Docs, Slides, Gmail, Calendar, Tasks, People, Chat, Forms, Meet, Keep, Classroom, Apps Script).",
  "Commands are `gws <service> <resource> [sub-resource] <method> --params '<JSON>' [--json '<JSON body>']`, mirroring the Google REST APIs; helpers start with + (gmail +send, sheets +read, sheets +append, calendar +agenda, drive +upload).",
  "Find a method with help (e.g. [\"drive\"], [\"drive\",\"files\"]) and its parameters with schema (\"drive.files.list\"), then call run with args as an array of strings (no shell, no quoting).",
  `Files live in ${WORK_DIR}: --upload, --attach, drive +upload take paths there, --output writes there; large output is saved there. Hand files over with plugin_download_file; take user files in with plugin_upload_file.`,
  "Call auth_status to see which Google identity is used. gws auth login/setup/export are disabled; credentials come from WorkMux.",
].join("\n");

const TOOLS = [
  {
    name: "run",
    title: "Run a gws command",
    description:
      "Run the Google Workspace CLI: gws <args...>, without a shell. args is the argument list, e.g. " +
      '["drive","files","list","--params","{\\"pageSize\\":10,\\"q\\":\\"trashed=false\\"}"] or ["sheets","+read","--spreadsheet","ID","--range","Sheet1!A1:D10"]. ' +
      "Returns {exit_code, stdout (parsed JSON when possible), stderr}. Output over 64 KB is written to a file in /work and its path returned. " +
      "File flags (--upload, --output, --output-dir, --attach/-a, --dir, the file of drive +upload) take paths in /work; relative paths resolve against /work. " +
      "Add --dry-run to see the request without sending it. Exit codes: 1 API error, 2 auth error, 3 bad arguments, 4 discovery failed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["args"],
      properties: {
        args: { type: "array", items: { type: "string" }, minItems: 1, description: "Arguments after `gws`, one string each; JSON for --params/--json is one string" },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_S, description: `Stop gws after this many seconds (default ${DEFAULT_TIMEOUT_S})` },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "schema",
    title: "Describe an API method",
    description: "gws schema <service.resource.method>: the method's HTTP verb, path parameters, query parameters (--params) and request body (--json), e.g. \"drive.files.list\", \"sheets.spreadsheets.values.get\", \"gmail.users.messages.send\". Needs no credentials.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["method"],
      properties: {
        method: { type: "string", description: "service.resource[.sub-resource].method, e.g. calendar.events.list" },
        resolve_refs: { type: "boolean", description: "Inline referenced schemas (bigger output)" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "help",
    title: "Show gws help",
    description: "gws [command...] --help: the services (no command), a service's resources and + helpers ([\"gmail\"]), a resource's methods ([\"drive\",\"files\"]) or a method's or helper's flags ([\"gmail\",\"+send\"]). Needs no credentials.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "array", items: { type: "string" }, description: 'Command words, e.g. ["calendar","events"] or ["sheets","+append"]; empty for the overview' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "auth_status",
    title: "Which Google credentials are used",
    description: "Which credentials the next call would use (WorkMux OAuth token, access token, service account key or none) and, for a service account, its e-mail to share files with. Never returns the secret.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });

async function callTool(name, a, extra) {
  const args = a || {};
  if (name === "run") {
    const { args: argv, needsAuth } = checkArgs(args.args);
    const auth = resolveAuth(extra);
    if (needsAuth && !auth) return errorResult(NO_AUTH_TEXT);
    const timeoutS = Math.min(Math.max(Number(args.timeout_seconds) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
    checkNoDotenv();
    const r = await runGws(argv, { auth, timeoutS, signal: extra.signal, outName: "gws-run" });
    return formatResult(r, { args: argv, auth, timeoutS });
  }
  if (name === "schema") {
    if (typeof args.method !== "string" || !/^[A-Za-z0-9_-]+(:[A-Za-z0-9_.-]+)?(\.[A-Za-z0-9_-]+)+$/.test(args.method)) {
      return errorResult('method must look like service.resource.method, e.g. "drive.files.list" (use help to find it)');
    }
    const argv = ["schema", args.method, ...(args.resolve_refs ? ["--resolve-refs"] : [])];
    checkNoDotenv();
    const r = await runGws(argv, { auth: null, timeoutS: 60, signal: extra.signal, outName: "gws-schema" });
    return formatResult(r, { args: argv, auth: null, timeoutS: 60 });
  }
  if (name === "help") {
    const words = args.command ?? [];
    if (!Array.isArray(words) || words.length > 6 || words.some((w) => typeof w !== "string" || !/^\+?[A-Za-z0-9_.:-]+$/.test(w) || w.startsWith("-"))) {
      return errorResult('command must be a list of command words without flags, e.g. ["drive","files"] or ["gmail","+send"]');
    }
    const argv = [...(words[0] === "gws" ? words.slice(1) : words), "--help"];
    checkNoDotenv();
    const r = await runGws(argv, { auth: null, timeoutS: 60, signal: extra.signal, outName: "gws-help" });
    if (r.spawnError) return errorResult(`Cannot start gws: ${r.spawnError.message}`);
    const text = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
    return { content: [{ type: "text", text: text || `(no help output, exit code ${r.code})` }], isError: r.code !== 0 && !r.stdout.trim() };
  }
  if (name === "auth_status") {
    const auth = resolveAuth(extra);
    const status = {
      active: auth ? auth.source : "none",
      description: auth ? SOURCE_TEXT[auth.source] : NO_AUTH_TEXT,
      available: {
        header_token: Boolean(headerToken(extra)),
        env_token: Boolean(env.GOOGLE_WORKSPACE_CLI_TOKEN),
        service_account: serviceAccount ? { email: serviceAccount.email } : false,
        credentials_file: Boolean(env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE),
      },
    };
    if (auth?.source === "service-account") status.note = `Acting as the service account ${serviceAccount.email}: share Drive files, folders and calendars with that e-mail first. It has no Gmail mailbox of its own.`;
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
  return errorResult(`Unknown tool ${name}`);
}

function createMcpServer() {
  const server = new Server({ name: "gws", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      return await callTool(req.params.name, req.params.arguments, extra);
    } catch (err) {
      if (err instanceof ToolError) return errorResult(err.message);
      log(`tool ${req.params.name} failed:`, err?.message);
      return errorResult(`Internal error: ${err?.message}`);
    }
  });
  return server;
}

// ---------------------------------------------------------------------------------------------
// Sessions and HTTP

const sessions = new Map(); // id -> { transport, server, lastSeen }
let shuttingDown = false;

async function closeSession(id, reason) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  log(`session ${id} closed (${reason})`);
  await Promise.allSettled([s.transport.close(), s.server.close()]);
}

async function newSession(req, res, body) {
  if (sessions.size >= MAX_SESSIONS) {
    const [oldest] = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    if (oldest) await closeSession(oldest[0], "too many sessions");
  }
  const s = { lastSeen: Date.now() };
  s.transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      s.id = id;
      sessions.set(id, s);
      log(`session ${id} started`);
    },
  });
  s.transport.onclose = () => s.id && closeSession(s.id, "transport closed");
  s.server = createMcpServer();
  await s.server.connect(s.transport);
  await s.transport.handleRequest(req, res, body);
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!size) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400, rpcCode: -32700 }));
      }
    });
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname === "/healthz") return sendJson(res, shuttingDown ? 503 : 200, { ok: !shuttingDown, sessions: sessions.size });
    if (url.pathname !== MCP_PATH) return sendJson(res, 404, { error: "not found" });
    if (shuttingDown) return sendJson(res, 503, { jsonrpc: "2.0", error: { code: -32000, message: "server is shutting down" }, id: null });

    const body = req.method === "POST" ? await readBody(req) : undefined;
    const sid = req.headers["mcp-session-id"];
    if (sid) {
      const s = sessions.get(Array.isArray(sid) ? sid[0] : sid);
      if (!s) return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      s.lastSeen = Date.now();
      return await s.transport.handleRequest(req, res, body);
    }
    if (req.method === "POST" && body && !Array.isArray(body) && isInitializeRequest(body)) return await newSession(req, res, body);
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid Mcp-Session-Id header (send initialize first)" }, id: null });
  } catch (err) {
    log("request failed:", err?.message);
    sendJson(res, err.status || 500, { jsonrpc: "2.0", error: { code: err.rpcCode || -32603, message: err.message }, id: null });
  }
});

const idleTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_IDLE_MS) closeSession(id, "idle");
}, 60_000);
idleTimer.unref();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: shutting down`);
  setTimeout(() => process.exit(0), 4_000).unref();
  for (const child of running) child.kill("SIGTERM");
  httpServer.close();
  httpServer.closeAllConnections?.();
  await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id, signal)));
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------------------------
// Start

fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(STATE_DIR, 0o700);
prepareServiceAccount();
try {
  log(`using ${execFileSync(GWS, ["--version"], { encoding: "utf8", env: childEnv(null), cwd: WORK_DIR }).split("\n")[0].trim()}`);
} catch (err) {
  log(`warning: ${GWS} --version failed: ${err.message}`);
}
httpServer.listen(PORT, HOST, () => log(`gws MCP on http://${HOST}:${PORT}${MCP_PATH}, files in ${WORK_DIR}`));
