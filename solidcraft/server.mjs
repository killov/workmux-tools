// WorkMux plugin: SolidCraft (headless parametric CAD) behind a streamable HTTP MCP endpoint.
//
// Every MCP session gets its own `solidcraft-cli mcp --headless` child process (one design
// session), talking MCP over stdio. This server forwards tools/list and tools/call to it and
// enforces the WorkMux plugin contract on top:
//   - file paths are confined to WORK_DIR (/work); relative paths are resolved against it,
//   - files never travel inline: images the child returns (screenshot, compare_picture overlay)
//     are written as PNG files into WORK_DIR and only their paths are returned,
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

const env = process.env;
const WORK_DIR = path.resolve(env.WORK_DIR || "/work");
const SOLIDCRAFT_CLI = env.SOLIDCRAFT_CLI || "solidcraft-cli";
const HOST = env.HOST || "0.0.0.0";
const PORT = Number(env.PORT || 8080);
const MCP_PATH = env.MCP_PATH || "/mcp";
const SLUG = "solidcraft";
const CALL_TIMEOUT_MS = Number(env.SOLIDCRAFT_CALL_TIMEOUT_MS || 300_000);
const START_TIMEOUT_MS = Number(env.SOLIDCRAFT_START_TIMEOUT_MS || 30_000);
const SESSION_IDLE_MS = Number(env.SESSION_IDLE_MINUTES || 60) * 60_000;
const MAX_SESSIONS = Number(env.MAX_SESSIONS || 4);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
// WorkMux shows tools as <slug>__<tool>, at most 64 characters.
const MAX_TOOL_NAME = 64 - SLUG.length - 2;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

// Top-level arguments of SolidCraft tools that name a file.
const PATH_ARGS = {
  open: ["path"],
  save: ["path"],
  export: ["path"],
  screenshot: ["path"],
  compare_picture: ["reference"],
  batch: ["path"],
};
// Parameter keys inside execute/batch command params that may name a file. Only absolute paths
// are checked there (a relative value can be something else, e.g. a sketch name for a sweep);
// relative ones resolve against the child's working directory, which is WORK_DIR.
const NESTED_FILE_KEYS = new Set(["path", "file", "filename", "file_path", "reference", "out", "output", "dir", "directory", "folder"]);

const WORKMUX_NOTE = [
  "WorkMux: this SolidCraft server runs headless in a container. Files live in /work only:",
  "every path you pass (open, save, export, screenshot, compare_picture reference, batch path,",
  "file paths inside execute/batch params) must be inside /work; relative paths resolve against /work.",
  "Tools never return file contents: screenshot saves a PNG into /work and returns its path.",
  "To hand a file to the user, download it from /work with plugin_download_file.",
  "Save the design (save {path: \"/work/<name>.sc\"}) after each stage: a new MCP session starts a fresh, empty design.",
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
  if (typeof value !== "string" || value.trim() === "") throw new PathError(`${what} must be a non-empty path inside ${WORK_DIR}`);
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
      if (typeof v === "string" && NESTED_FILE_KEYS.has(k) && path.isAbsolute(v)) resolveInWork(v, `${where}.${k}`);
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

// Rewrite tool arguments: confine paths to WORK_DIR, give screenshot a file in WORK_DIR.
function prepareArgs(tool, args) {
  const out = { ...(args || {}) };
  for (const key of PATH_ARGS[tool] || []) {
    if (out[key] !== undefined) out[key] = resolveInWork(out[key], `${tool}.${key}`);
  }
  if (tool === "screenshot" && out.path === undefined) {
    out.path = path.join(WORK_DIR, `screenshot-${stamp()}.png`);
  }
  if (tool === "execute" && out.params) checkNestedPaths(out.params, "params");
  if (tool === "batch" && Array.isArray(out.commands)) checkNestedPaths(out.commands, "commands");
  return out;
}

// Replace inline binary content with files in WORK_DIR.
function externalizeContent(tool, args, result) {
  if (!result || !Array.isArray(result.content)) return result;
  const content = [];
  let screenshotImageHandled = false;
  for (const block of result.content) {
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      if (tool === "screenshot" && !screenshotImageHandled && args.path && fs.existsSync(args.path)) {
        // SolidCraft already wrote this PNG to args.path.
        screenshotImageHandled = true;
        content.push({ type: "text", text: `PNG saved to ${args.path} (${fs.statSync(args.path).size} bytes). Download it with plugin_download_file to show it.` });
        continue;
      }
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

// Adjust the child's tool list for WorkMux: valid names only, path semantics in descriptions.
function adaptTools(tools) {
  const kept = [];
  for (const t of tools) {
    if (!TOOL_NAME_RE.test(t.name) || t.name.length > MAX_TOOL_NAME) {
      log(`skipping tool ${JSON.stringify(t.name)}: not a valid WorkMux tool name`);
      continue;
    }
    const tool = structuredClone(t);
    const props = tool.inputSchema?.properties || {};
    for (const key of PATH_ARGS[tool.name] || []) {
      if (props[key]) props[key].description = `${props[key].description || "File path"} (inside ${WORK_DIR}; a relative path resolves against ${WORK_DIR})`;
    }
    if (tool.name === "screenshot") {
      tool.description = `Render the design to a PNG file in ${WORK_DIR} and return its path (no inline image; default ${WORK_DIR}/screenshot-<time>.png). ` + tool.description.replace(/^Render the design and return it as a PNG image\.\s*/, "");
    }
    if (tool.name === "compare_picture") {
      tool.description += ` The overlay PNG is saved into ${WORK_DIR} and its path returned instead of an inline image.`;
    }
    kept.push(tool);
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------
// Sessions: one SolidCraft child per MCP session

const sessions = new Map(); // id -> session
let shuttingDown = false;

async function startBackend() {
  const transport = new StdioClientTransport({
    command: SOLIDCRAFT_CLI,
    args: ["mcp", "--headless", "--allow-path", WORK_DIR, "--require-allow-path"],
    cwd: WORK_DIR,
    env: { ...getDefaultEnvironment(), ...pickEnv(["TMPDIR", "SOLIDCRAFT_MCP_COMPACT", "SOLIDCRAFT_GPU", "RUST_LOG"]) },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => process.stderr.write(`[solidcraft] ${d}`));
  const client = new Client({ name: "workmux-solidcraft-proxy", version: "0.1.0" });
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`solidcraft-cli did not initialize within ${START_TIMEOUT_MS} ms`)), START_TIMEOUT_MS);
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

function pickEnv(keys) {
  const out = {};
  for (const k of keys) if (env[k] !== undefined) out[k] = env[k];
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
      return externalizeContent(name, args, result);
    } catch (err) {
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        return {
          content: [{ type: "text", text: `${name} did not finish within ${Math.round(CALL_TIMEOUT_MS / 1000)} s. SolidCraft may still be working on it; call inspect_design before sending the change again.` }],
          isError: true,
        };
      }
      if (err instanceof McpError && err.code === ErrorCode.ConnectionClosed) {
        return { content: [{ type: "text", text: "The SolidCraft process ended (it may have crashed). Reconnect to start a new design session, then open your last saved .sc file from /work." }], isError: true };
      }
      throw err;
    }
  });

  if (backendCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (req) => client.listResources(req.params, { timeout: CALL_TIMEOUT_MS }));
    server.setRequestHandler(ReadResourceRequestSchema, (req) => client.readResource(req.params, { timeout: CALL_TIMEOUT_MS }));
  }
  return server;
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
    log("cannot start solidcraft-cli:", err.message);
    return sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: `Cannot start SolidCraft: ${err.message}` }, id: body?.id ?? null });
  }
  sess.httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sess.id = id;
      sessions.set(id, sess);
      log(`session ${id} started (solidcraft pid ${sess.backend.transport.pid})`);
    },
  });
  sess.httpTransport.onclose = () => sess.id && closeSession(sess.id, "transport closed");
  sess.backend.client.onclose = () => {
    if (sess.id) closeSession(sess.id, "solidcraft-cli exited");
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
  log(`using ${execFileSync(SOLIDCRAFT_CLI, ["--version"], { encoding: "utf8" }).trim()}`);
} catch (err) {
  log(`warning: ${SOLIDCRAFT_CLI} --version failed: ${err.message}`);
}
httpServer.listen(PORT, HOST, () => log(`SolidCraft MCP on http://${HOST}:${PORT}${MCP_PATH}, files in ${WORK_DIR}`));
