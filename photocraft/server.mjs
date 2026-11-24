// GENERATED from craft-common/server.mjs by craft-common/sync.mjs — do not edit, run the sync instead.
// WorkMux plugin: an ArtCraft application (PhotoCraft, FilmCraft, …) behind a streamable HTTP MCP endpoint.
//
// The application comes from craft.json next to this file (`app`, `name`, `hideTools`, `callTimeoutMs`), so the
// code is the same for every Craft plugin. Every MCP session gets its own headless `<app>-cli mcp` child process
// (one editing session) talking MCP over stdio, with /work as its automation read and write root. This server
// forwards tools and resources to it and enforces the WorkMux plugin contract on top:
//   - file paths are confined to WORK_DIR (/work); relative paths are resolved against it,
//   - files never travel inline: images the child returns (render_preview) are written into WORK_DIR and only
//     their paths are returned,
//   - every call has a timeout, unknown sessions get 404, SIGTERM shuts down within seconds.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------------------------
// Configuration

const CRAFT = JSON.parse(fs.readFileSync(new URL("./craft.json", import.meta.url), "utf8"));
const env = process.env;
const SLUG = CRAFT.app;
const APP_NAME = CRAFT.name;
const WORK_DIR = path.resolve(env.WORK_DIR || "/work");
const CRAFT_CLI = env.CRAFT_CLI || `${SLUG}-cli`;
const HOST = env.HOST || "0.0.0.0";
const PORT = Number(env.PORT || 8080);
const MCP_PATH = env.MCP_PATH || "/mcp";
const CALL_TIMEOUT_MS = Number(env.CRAFT_CALL_TIMEOUT_MS || CRAFT.callTimeoutMs);
const START_TIMEOUT_MS = Number(env.CRAFT_START_TIMEOUT_MS || 30_000);
const SESSION_IDLE_MS = Number(env.SESSION_IDLE_MINUTES || 60) * 60_000;
const MAX_SESSIONS = Number(env.MAX_SESSIONS || 4);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
// WorkMux shows tools as <slug>__<tool>, at most 64 characters.
const MAX_TOOL_NAME = 64 - SLUG.length - 2;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
// Bridge-only tools (ui_*, control_call) only return an error in the headless engine, so they are not listed.
const HIDDEN_TOOLS = CRAFT.hideTools.map((re) => new RegExp(re));
// Variables of the application itself (e.g. PHOTOCRAFT_GPU) reach the child; nothing else from this env does.
const APP_ENV_PREFIX = `${SLUG.toUpperCase()}_`;

// Argument keys that name a file or directory (doc_open.path, doc_export.path, doc_export_layers.dir, …; the
// tool names differ between the Craft apps). Top-level values are resolved against WORK_DIR. Inside nested
// objects (command_run params, command_batch steps) only absolute paths are checked: a relative value can be
// something else there, e.g. a vector path name, and the child resolves relative files beneath its roots anyway.
const FILE_KEYS = new Set(["path", "file", "filename", "file_path", "out", "output", "dir", "directory", "folder"]);
// Tools that answer with an inline image.
const IMAGE_TOOLS = new Set(["render_preview", "doc_render_preview"]);

const WORKMUX_NOTE = [
  `WorkMux: this ${APP_NAME} server runs headless in a container. Files live in /work only:`,
  "every path you pass (doc_open, doc_save, doc_export, export dirs, file paths inside command params)",
  "must be inside /work; relative paths resolve against /work.",
  "Tools never return file contents: render_preview saves a PNG into /work and returns its path.",
  "The command registry has hundreds of commands: always call command_list with a filter (e.g. {\"filter\":\"crop\"}), never unfiltered.",
  "To hand a file to the user, download it from /work with plugin_download_file.",
  "Save your work into /work after each stage: a new MCP session starts with no open document.",
].join(" ");

const log = (...args) => console.error(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------------------------
// Paths

class PathError extends Error {}

function isInside(dir, p) {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Resolve a user path against WORK_DIR and make sure it (and any symlink on the way) stays inside.
function resolveInWork(value, what) {
  if (value.trim() === "") throw new PathError(`${what} must be a non-empty path inside ${WORK_DIR}`);
  const abs = path.resolve(WORK_DIR, value);
  if (!isInside(WORK_DIR, abs)) throw new PathError(`${what} ${JSON.stringify(value)} is outside ${WORK_DIR}; only files in ${WORK_DIR} are reachable`);
  // Follow symlinks of the longest existing prefix.
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== WORK_DIR) probe = path.dirname(probe);
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    real = probe;
  }
  const realWork = fs.realpathSync(WORK_DIR);
  if (!isInside(realWork, real)) throw new PathError(`${what} ${JSON.stringify(value)} leads outside ${WORK_DIR} through a symlink`);
  return abs;
}

function checkNestedPaths(node, where) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => checkNestedPaths(v, `${where}[${i}]`));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && FILE_KEYS.has(k) && path.isAbsolute(v)) resolveInWork(v, `${where}.${k}`);
      else checkNestedPaths(v, `${where}.${k}`);
    }
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "") + "-" + randomUUID().slice(0, 4);
}

function extFor(mime) {
  return { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "audio/wav": "wav", "audio/mpeg": "mp3" }[mime] || "bin";
}

// Rewrite tool arguments: top-level file arguments become absolute paths in WORK_DIR, nested ones are checked.
function prepareArgs(tool, args) {
  const out = { ...(args || {}) };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && FILE_KEYS.has(key)) out[key] = resolveInWork(value, `${tool}.${key}`);
    else checkNestedPaths(value, `${tool}.${key}`);
  }
  return out;
}

// Replace inline binary content with files in WORK_DIR.
function externalizeContent(tool, result) {
  if (!result || !Array.isArray(result.content)) return result;
  const content = [];
  for (const block of result.content) {
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      const file = path.join(WORK_DIR, `${tool}-${stamp()}.${extFor(block.mimeType)}`);
      fs.writeFileSync(file, Buffer.from(block.data, "base64"));
      content.push({ type: "text", text: `${block.type === "image" ? "Image" : "Audio"} (${block.mimeType}) saved to ${file}. Download it with plugin_download_file to show it.` });
    } else if (block.type === "resource" && block.resource && typeof block.resource.blob === "string") {
      const file = path.join(WORK_DIR, `${tool}-${stamp()}.${extFor(block.resource.mimeType)}`);
      fs.writeFileSync(file, Buffer.from(block.resource.blob, "base64"));
      content.push({ type: "text", text: `Resource ${block.resource.uri} (${block.resource.mimeType || "binary"}) saved to ${file}.` });
    } else {
      content.push(block);
    }
  }
  return { ...result, content };
}

// Adjust the child's tool list for WorkMux: no bridge-only tools, valid names only, path semantics in descriptions.
function adaptTools(tools) {
  const kept = [];
  for (const t of tools) {
    if (HIDDEN_TOOLS.some((re) => re.test(t.name))) continue;
    if (!TOOL_NAME_RE.test(t.name) || t.name.length > MAX_TOOL_NAME) {
      log(`skipping tool ${JSON.stringify(t.name)}: not a valid WorkMux tool name`);
      continue;
    }
    const tool = structuredClone(t);
    for (const [key, prop] of Object.entries(tool.inputSchema?.properties || {})) {
      if (FILE_KEYS.has(key)) prop.description = `${prop.description || "File path"} (inside ${WORK_DIR}; a relative path resolves against ${WORK_DIR})`;
    }
    if (IMAGE_TOOLS.has(tool.name)) {
      tool.description = `${tool.description} The PNG is saved into ${WORK_DIR} and its path returned instead of an inline image.`;
    }
    kept.push(tool);
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------
// Sessions: one <app>-cli child per MCP session

const sessions = new Map(); // id -> session
let shuttingDown = false;

async function startBackend() {
  const transport = new StdioClientTransport({
    command: CRAFT_CLI,
    args: ["mcp", "--automation-read-root", WORK_DIR, "--automation-write-root", WORK_DIR],
    cwd: WORK_DIR,
    env: { ...getDefaultEnvironment(), ...appEnv() },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => process.stderr.write(`[${SLUG}] ${d}`));
  const client = new Client({ name: `workmux-${SLUG}-proxy`, version: "0.1.0" });
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${CRAFT_CLI} did not initialize within ${START_TIMEOUT_MS} ms`)), START_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    await transport.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return { client, transport };
}

function appEnv() {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k === "TMPDIR" || k === "RUST_LOG" || k.startsWith(APP_ENV_PREFIX)) out[k] = v;
  return out;
}

function createProxyServer(sess) {
  const { client } = sess.backend;
  const backendInfo = client.getServerVersion();
  const backendCaps = client.getServerCapabilities() || {};
  const server = new Server(
    { name: SLUG, version: backendInfo?.version || "unknown" },
    {
      capabilities: { tools: {}, ...(backendCaps.resources ? { resources: {} } : {}) },
      instructions: `${WORKMUX_NOTE}\n\n${client.getInstructions() || ""}`.trim(),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!sess.tools) {
      const all = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: CALL_TIMEOUT_MS });
        all.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      sess.tools = adaptTools(all);
    }
    return { tools: sess.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    let args;
    try {
      args = prepareArgs(name, req.params.arguments);
    } catch (err) {
      if (err instanceof PathError) return { content: [{ type: "text", text: err.message }], isError: true };
      throw err;
    }
    try {
      const result = await client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
        { timeout: CALL_TIMEOUT_MS, signal: extra.signal },
      );
      return externalizeContent(name, result);
    } catch (err) {
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        return {
          content: [{ type: "text", text: `${name} did not finish within ${Math.round(CALL_TIMEOUT_MS / 1000)} s. ${APP_NAME} may still be working on it; check jobs_list and doc_inspect before sending the change again.` }],
          isError: true,
        };
      }
      if (err instanceof McpError && err.code === ErrorCode.ConnectionClosed) {
        return { content: [{ type: "text", text: `The ${APP_NAME} process ended (it may have crashed). Reconnect to start a new session, then open your last saved file from /work.` }], isError: true };
      }
      throw err;
    }
  });

  if (backendCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (req) => client.listResources(req.params, { timeout: CALL_TIMEOUT_MS }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const result = await client.readResource(req.params, { timeout: CALL_TIMEOUT_MS });
      return { ...result, contents: result.contents.map((c) => (typeof c.blob === "string" ? externalizeBlob(c) : c)) };
    });
  }
  return server;
}

// A binary resource becomes a file in WORK_DIR; the reader gets its path as text.
function externalizeBlob(c) {
  const file = path.join(WORK_DIR, `resource-${stamp()}.${extFor(c.mimeType)}`);
  fs.writeFileSync(file, Buffer.from(c.blob, "base64"));
  return { uri: c.uri, mimeType: "text/plain", text: `${c.mimeType || "binary"} content saved to ${file}.` };
}

async function closeSession(id, reason) {
  const sess = sessions.get(id);
  if (!sess || sess.closing) return;
  sess.closing = true;
  sessions.delete(id);
  log(`session ${id} closed (${reason})`);
  await Promise.allSettled([sess.httpTransport.close(), sess.backend.client.close()]);
}

async function newSession(req, res, body) {
  if (sessions.size >= MAX_SESSIONS) {
    // Drop the least recently used session to make room.
    const [oldest] = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    if (oldest) await closeSession(oldest[0], "too many sessions");
  }
  const sess = { lastSeen: Date.now(), tools: null, closing: false };
  try {
    sess.backend = await startBackend();
  } catch (err) {
    log(`cannot start ${CRAFT_CLI}:`, err.message);
    return sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: `Cannot start ${APP_NAME}: ${err.message}` }, id: body?.id ?? null });
  }
  sess.httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sess.id = id;
      sessions.set(id, sess);
      log(`session ${id} started (${SLUG} pid ${sess.backend.transport.pid})`);
    },
  });
  sess.httpTransport.onclose = () => sess.id && closeSession(sess.id, "transport closed");
  sess.backend.client.onclose = () => {
    if (sess.id) closeSession(sess.id, `${CRAFT_CLI} exited`);
  };
  sess.server = createProxyServer(sess);
  await sess.server.connect(sess.httpTransport);
  await sess.httpTransport.handleRequest(req, res, body);
  if (!sess.id) {
    // Initialization failed; do not leak the child.
    await sess.backend.client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP

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
    if (url.pathname === "/healthz") {
      return sendJson(res, shuttingDown ? 503 : 200, { ok: !shuttingDown, sessions: sessions.size });
    }
    if (url.pathname !== MCP_PATH) return sendJson(res, 404, { error: "not found" });
    if (shuttingDown) return sendJson(res, 503, { jsonrpc: "2.0", error: { code: -32000, message: "server is shutting down" }, id: null });

    const body = req.method === "POST" ? await readBody(req) : undefined;
    const sid = req.headers["mcp-session-id"];
    if (sid) {
      const sess = sessions.get(Array.isArray(sid) ? sid[0] : sid);
      // Unknown session: 404 tells the client to initialize again.
      if (!sess) return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      sess.lastSeen = Date.now();
      return await sess.httpTransport.handleRequest(req, res, body);
    }
    if (req.method === "POST" && body && !Array.isArray(body) && isInitializeRequest(body)) {
      return await newSession(req, res, body);
    }
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid Mcp-Session-Id header (send initialize first)" }, id: null });
  } catch (err) {
    log("request failed:", err);
    sendJson(res, err.status || 500, { jsonrpc: "2.0", error: { code: err.rpcCode || -32603, message: err.message }, id: null });
  }
});

// ---------------------------------------------------------------------------------------------
// Lifecycle

const idleTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) if (now - sess.lastSeen > SESSION_IDLE_MS) closeSession(id, "idle");
}, 60_000);
idleTimer.unref();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: shutting down`);
  setTimeout(() => process.exit(0), 5_000).unref();
  httpServer.close();
  httpServer.closeAllConnections?.();
  // Ask the children to stop right away instead of waiting for stdin EOF timeouts.
  for (const sess of sessions.values()) {
    const pid = sess.backend.transport.pid;
    if (pid) try { process.kill(pid, "SIGTERM"); } catch {}
  }
  await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id, signal)));
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

fs.mkdirSync(WORK_DIR, { recursive: true });
try {
  log(`using ${execFileSync(CRAFT_CLI, ["--version"], { encoding: "utf8" }).trim()}`);
} catch (err) {
  log(`warning: ${CRAFT_CLI} --version failed: ${err.message}`);
}
httpServer.listen(PORT, HOST, () => log(`${APP_NAME} MCP on http://${HOST}:${PORT}${MCP_PATH}, files in ${WORK_DIR}`));
