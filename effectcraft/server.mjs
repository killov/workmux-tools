// GENERATED from craft-common/server.mjs by craft-common/sync.mjs — do not edit, run the sync instead.
// WorkMux plugin: an ArtCraft application (PhotoCraft, FilmCraft, …) behind a streamable HTTP MCP endpoint.
//
// The application comes from craft.json next to this file (`app`, `name`, `hideTools`, `callTimeoutMs`, `engineRoots`,
// `fileKeys`, `nonFileArgs`, `base64Keys`, `encodeMp3`), so the code is the same for every Craft plugin. Every MCP
// session gets its own headless `<app>-cli mcp` child process (one editing session) talking MCP over stdio in
// WORK_DIR, with /work as its automation read and write root when the engine has them (`engineRoots`). This server
// forwards tools and resources to it (plus its own encode_mp3 with `encodeMp3`) and enforces the WorkMux plugin
// contract on top:
//   - file paths are confined to WORK_DIR (/work); relative paths are resolved against it,
//   - files never travel inline: images the child returns (render_preview) and file bytes in its JSON answers
//     (dataBase64, pngBase64) are written into WORK_DIR and only their paths are returned,
//   - every call has a timeout, unknown sessions get 404, SIGTERM shuts down within seconds.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

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
// The same as idleMinutes in the manifests: a session outliving its container's idle time only holds memory.
const SESSION_IDLE_MS = Number(env.SESSION_IDLE_MINUTES || 30) * 60_000;
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
// tool names differ between the Craft apps). Top-level values become absolute paths in WORK_DIR. Inside nested
// objects (command_run params, command_batch steps) they are checked against WORK_DIR as well but passed on as
// they are: a relative value can be something else there, e.g. a VectorCraft path object id. Any other string,
// under any key and at any depth, is checked too when it looks like a path (absolute or going up with ..).
const FILE_KEYS = new Set(["path", "file", "filename", "file_path", "out", "output", "dir", "directory", "folder"]);
// `nonFileArgs` in craft.json names top-level keys of one app's tools that are not files despite their name
// (EffectCraft set_property.path is a property path like transform/opacity); they are only checked like any string.
const NON_FILE_ARGS = new Map(Object.entries(CRAFT.nonFileArgs ?? {}).map(([tool, keys]) => [tool, new Set(keys)]));
const isNonFileArg = (tool, key) => NON_FILE_ARGS.get(tool)?.has(key) ?? false;
// An engine without --automation-read-root/--automation-write-root (FilmCraft) reads and writes wherever it is
// told, so this server is the only fence: a few more keys name files in its commands
// (file.projectManager.destination, the scratch disks, template paths, media.autoRelink from/to), and lists of files
// (media_import.paths, file.import.paths) become absolute paths in WORK_DIR, as the engine wants them.
const ENGINE_ROOTS = CRAFT.engineRoots ?? true;
// `fileKeys` in craft.json names further file keys of one app's commands (LightCraft folder.move.into, …).
const NESTED_FILE_KEYS = new Set([
  ...FILE_KEYS,
  ...(ENGINE_ROOTS ? [] : ["destination", "template", "captured", "videoPreviews", "audioPreviews", "autoSave", "from", "to"]),
  ...(CRAFT.fileKeys ?? []),
]);
const FILE_LIST_KEYS = new Set(["paths", "files"]);
// JSON keys of file bytes in the child's answers; `base64Keys` in craft.json adds keys of one app (FigCraft's export
// answers {"format": ..., "data": ...}), a key as generic as `data` is not base64 in every app.
const APP_BASE64_KEYS = new Set(CRAFT.base64Keys ?? []);
// `base64Formats` in craft.json maps keys that are file bytes in every answer of one app, also without a `format`
// next to them, to the format of those bytes (DeckCraft's file.render answers {"png": ...}, file.saveBytes
// {"data": ...}).
const BASE64_FORMATS = new Map(Object.entries(CRAFT.base64Formats ?? {}));
const BASE64_KEYS = new Set(["dataBase64", "pngBase64", ...APP_BASE64_KEYS, ...BASE64_FORMATS.keys()]);
// File extension of an inline export by its `format` (the export formats of the Craft apps); others are refused.
const EXT_BY_FORMAT = new Map(Object.entries({
  png: "png", png8: "png", jpg: "jpg", jpeg: "jpg", webp: "webp", gif: "gif", bmp: "bmp", tga: "tga", exr: "exr",
  tif: "tif", tiff: "tif", psd: "psd", psb: "psb", ora: "ora", svg: "svg", svgz: "svgz", pdf: "pdf", eps: "eps",
  ai: "ai", dxf: "dxf", fig: "fig", pptx: "pptx", deckcraft: "deckcraft",
}));
// Leading bytes of the formats a `base64Formats` key can stand for: one key may carry several formats (GridCraft's
// `base64` is a PDF from file.exportPdf but an XLSX or CSV from file.saveBytes), so bytes that do not match are
// refused instead of saved under a wrong extension.
const MAGIC_BY_FORMAT = new Map(Object.entries({
  pdf: Buffer.from("%PDF-"),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pptx: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
}));
// Tools that answer with an inline image.
const IMAGE_TOOLS = new Set(["render_preview", "doc_render_preview", "render_photo", "screenshot"]);
// An engine that bounces audio but cannot write MP3 (SoundCraft) gets encode_mp3 from this server, run with lame.
const LAME = env.CRAFT_LAME_BIN || "lame";
const execFileAsync = promisify(execFile);
const MP3_TOOL = {
  name: "encode_mp3",
  description: `Encodes a WAV file (16/24-bit PCM or 32-bit float, e.g. from bounce_mix) to MP3 (CBR) with lame and returns the MP3's path and size. Both files are inside ${WORK_DIR}.`,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: `Source WAV file (inside ${WORK_DIR}; a relative path resolves against ${WORK_DIR})` },
      out: { type: "string", description: `Target .mp3 file (inside ${WORK_DIR}); default: the source's name with .mp3 next to it. An existing file is replaced.` },
      bitrate_kbps: { type: "integer", minimum: 32, maximum: 320, description: "Bit rate in kbit/s, default 192" },
    },
    required: ["path"],
  },
};

const WORKMUX_NOTE = [
  `WorkMux: this ${APP_NAME} server runs headless in a container. Files live in /work only:`,
  "every path you pass (to open, save and export files, export dirs, file paths inside command params)",
  "must be inside /work; relative paths resolve against /work.",
  "Tools never return file contents: previews and exports are saved into /work and returned as paths.",
  "The command registry has hundreds of commands: always list commands with a filter (e.g. {\"filter\":\"crop\"}), never unfiltered.",
  "To hand a file to the user, download it from /work with plugin_download_file.",
  "Save your work into /work after each stage: a new MCP session starts with no open document.",
].join(" ");

const log = (...args) => console.error(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------------------------
// Paths

class PathError extends Error {}

function isInside(dir, p) {
  const rel = path.relative(dir, p);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel));
}

function looksLikePath(s) {
  return path.isAbsolute(s) || s === ".." || s.startsWith("../") || s.includes("/../") || s.endsWith("/..");
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

// Check an argument value under `key` (null for list items) and return it with lists of files rewritten.
function prepareNested(key, value, where) {
  if (typeof value === "string") {
    if (NESTED_FILE_KEYS.has(key) && value.trim() !== "") resolveInWork(value, where);
    else if (looksLikePath(value)) resolveInWork(value, `${where} (looks like a path)`);
    return value;
  }
  if (Array.isArray(value)) {
    const files = !ENGINE_ROOTS && FILE_LIST_KEYS.has(key);
    // A list under a file key holds files too, e.g. LightCraft library.autoImportScan.listing: [[path, size]].
    const itemKey = NESTED_FILE_KEYS.has(key) ? key : null;
    return value.map((v, i) => (files && typeof v === "string" ? resolveInWork(v, `${where}[${i}]`) : prepareNested(itemKey, v, `${where}[${i}]`)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, prepareNested(k, v, `${where}.${k}`)]));
  }
  return value;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "") + "-" + randomUUID().slice(0, 4);
}

function extFor(mime) {
  return { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "audio/wav": "wav", "audio/mpeg": "mp3" }[mime] || "bin";
}

// Rewrite tool arguments: top-level file arguments become absolute paths in WORK_DIR, everything else is checked.
function prepareArgs(tool, args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    const where = `${tool}.${key}`;
    if (isNonFileArg(tool, key)) out[key] = prepareNested(null, value, where);
    else out[key] = typeof value === "string" && FILE_KEYS.has(key) ? resolveInWork(value, where) : prepareNested(key, value, where);
  }
  return out;
}

// Replace inline binary content with files in WORK_DIR.
function externalizeContent(tool, result) {
  if (!result || !Array.isArray(result.content)) return result;
  const content = [];
  let failed = false;
  for (const block of result.content) {
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      const file = path.join(WORK_DIR, `${tool}-${stamp()}.${extFor(block.mimeType)}`);
      fs.writeFileSync(file, Buffer.from(block.data, "base64"));
      content.push({ type: "text", text: `${block.type === "image" ? "Image" : "Audio"} (${block.mimeType}) saved to ${file}. Download it with plugin_download_file to show it.` });
    } else if (block.type === "resource" && block.resource && typeof block.resource.blob === "string") {
      const file = path.join(WORK_DIR, `${tool}-${stamp()}.${extFor(block.resource.mimeType)}`);
      fs.writeFileSync(file, Buffer.from(block.resource.blob, "base64"));
      content.push({ type: "text", text: `Resource ${block.resource.uri} (${block.resource.mimeType || "binary"}) saved to ${file}.` });
    } else if (block.type === "text" && typeof block.text === "string" && [...BASE64_KEYS].some((k) => block.text.includes(`"${k}"`))) {
      const { text, error } = externalizeJsonData(tool, block.text);
      content.push({ ...block, text });
      failed ||= error;
    } else {
      content.push(block);
    }
  }
  return failed ? { ...result, content, isError: true } : { ...result, content };
}

// An export without a destination (VectorCraft's export, document.export in command_run/command_batch) answers
// JSON with the file as {"format": ..., "dataBase64": ...}, FilmCraft's graphics.template.thumbnail without a path
// as {"pngBase64": ...}; every such object gets a file in WORK_DIR and its `path` instead. The bytes never pass
// inline: an answer that does not parse or an unknown format is dropped and reported as an error.
function externalizeJsonData(tool, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { text: `${tool} answered with inline file data that could not be parsed; it was dropped. Export with a path inside ${WORK_DIR}.`, error: true };
  }
  let error = false;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, v] of Object.entries(node)) {
      // An app's own base64 key (e.g. `data`) only counts as file bytes next to a `format`; elsewhere it is plain data.
      if (BASE64_KEYS.has(key) && typeof v === "string" && !(APP_BASE64_KEYS.has(key) && typeof node.format !== "string")) {
        const guessed = key !== "pngBase64" && typeof node.format !== "string";
        const format = key === "pngBase64" ? "png" : guessed ? BASE64_FORMATS.get(key) : node.format;
        const ext = typeof format === "string" && EXT_BY_FORMAT.get(format.toLowerCase());
        if (!ext) {
          out.error = `unsupported export format ${JSON.stringify(format)}; export with a path inside ${WORK_DIR}`;
          error = true;
          continue;
        }
        const bytes = Buffer.from(v, "base64");
        const magic = guessed && MAGIC_BY_FORMAT.get(format);
        if (magic && !bytes.subarray(0, magic.length).equals(magic)) {
          out.error = `inline file data is not ${format}; export with a path inside ${WORK_DIR}`;
          error = true;
          continue;
        }
        out.path = path.join(WORK_DIR, `${tool}-${stamp()}.${ext}`);
        fs.writeFileSync(out.path, bytes);
      } else {
        out[key] = walk(v);
      }
    }
    return out;
  };
  return { text: JSON.stringify(walk(value), null, 2), error };
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
      // A key of the same name can hold something else, e.g. VectorCraft add_text.path is a path object id.
      if (FILE_KEYS.has(key) && !isNonFileArg(tool.name, key) && [prop.type].flat().includes("string")) prop.description = `${prop.description || "File path"} (inside ${WORK_DIR}; a relative path resolves against ${WORK_DIR})`;
    }
    if (IMAGE_TOOLS.has(tool.name)) {
      tool.description = `${tool.description} The PNG is saved into ${WORK_DIR} and its path returned instead of an inline image.`;
    }
    kept.push(tool);
  }
  return kept;
}

// encode_mp3 with the arguments from prepareArgs (path and out are absolute paths in WORK_DIR by then).
async function encodeMp3(args, signal) {
  const fail = (text) => ({ content: [{ type: "text", text: `encode_mp3: ${text}` }], isError: true });
  if (typeof args.path !== "string" || !fs.statSync(args.path, { throwIfNoEntry: false })?.isFile()) return fail(`path must be a WAV file inside ${WORK_DIR}`);
  if (args.out !== undefined && typeof args.out !== "string") return fail("out must be a path");
  const out = resolveInWork(args.out ?? args.path.replace(/(\.[^./]*)?$/, ".mp3"), "encode_mp3.out");
  if (!/\.mp3$/i.test(out)) return fail(`out ${out} must end with .mp3`);
  if (out === args.path) return fail("out must differ from path");
  const kbps = args.bitrate_kbps ?? 192;
  if (!Number.isInteger(kbps) || kbps < 32 || kbps > 320) return fail("bitrate_kbps must be an integer from 32 to 320");
  try {
    await execFileAsync(LAME, ["--quiet", "-b", String(kbps), args.path, out], { timeout: CALL_TIMEOUT_MS, signal });
  } catch (err) {
    // A failed or killed lame leaves a partial MP3 behind.
    fs.rmSync(out, { force: true });
    return fail(err.killed ? `lame did not finish within ${Math.round(CALL_TIMEOUT_MS / 1000)} s` : (err.stderr || err.message).trim().slice(-500));
  }
  return { content: [{ type: "text", text: JSON.stringify({ path: out, bytes: fs.statSync(out).size }, null, 2) }] };
}

// ---------------------------------------------------------------------------------------------
// Sessions: one <app>-cli child per MCP session

const sessions = new Map(); // id -> session
// Ids of sessions dropped for MAX_SESSIONS (the newest EVICTED_MAX), so their client learns why they are gone.
const evicted = new Set();
const EVICTED_MAX = 64;
let shuttingDown = false;

async function startBackend() {
  const transport = new StdioClientTransport({
    command: CRAFT_CLI,
    args: ENGINE_ROOTS ? ["mcp", "--automation-read-root", WORK_DIR, "--automation-write-root", WORK_DIR] : ["mcp"],
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
      sess.tools = [...adaptTools(all), ...(CRAFT.encodeMp3 ? [MP3_TOOL] : [])];
    }
    return { tools: sess.tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    let args;
    try {
      args = prepareArgs(name, req.params.arguments);
      if (CRAFT.encodeMp3 && name === MP3_TOOL.name) return await encodeMp3(args, extra.signal);
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
    if (oldest) {
      const [id, old] = oldest;
      evicted.add(id);
      if (evicted.size > EVICTED_MAX) evicted.delete(evicted.values().next().value);
      const idle = Math.round((Date.now() - old.lastSeen) / 1000);
      await closeSession(id, `MAX_SESSIONS ${MAX_SESSIONS} reached, least recently used, idle ${idle} s; unsaved document changes of this session are lost`);
    }
  }
  const sess = { lastSeen: Date.now(), tools: null, closing: false };
  try {
    sess.backend = await startBackend();
  } catch (err) {
    log(`cannot start ${CRAFT_CLI}:`, err.message);
    return sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: `Cannot start ${APP_NAME}: ${err.message}` }, id: body?.id ?? null });
  }
  try {
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
  } finally {
    // Initialization failed (or threw): do not leak the child, the transport or the server.
    if (!sess.id) await Promise.allSettled([sess.httpTransport?.close(), sess.server?.close(), sess.backend.client.close()]);
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
      const id = Array.isArray(sid) ? sid[0] : sid;
      const sess = sessions.get(id);
      // Unknown session: 404 tells the client to initialize again.
      if (!sess) {
        const message = evicted.has(id)
          ? `Session closed: the server reached MAX_SESSIONS (${MAX_SESSIONS}) parallel sessions and closed the least recently used one; unsaved changes are lost. Initialize again and reopen your last saved file from /work.`
          : "Session not found";
        return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message }, id: null });
      }
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
