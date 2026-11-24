#!/usr/bin/env node
// QA souborový server — přibalí ho `plugin-qa.mjs prepare` do QA image pluginu a běží
// vedle MCP serveru. Nahrazuje `plugin_upload_file` / `plugin_download_file` z WorkMuxu, které
// v session nejsou: QA přes něj nahraje vstup do /work a stáhne výstup toolu.
//
//   GET  /ls?path=<rel>    výpis adresáře v /work (JSON)
//   GET  /file/<rel>       obsah souboru
//   PUT  /file/<rel>       zápis souboru (adresáře se založí)
//
// Jen pro testovací image v session, nikdy do produkčního Dockerfile pluginu.
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

const WORK = path.resolve(process.env.WORK_DIR || "/work");
const PORT = Number(process.env.QA_FILES_PORT || 8099);

function resolveInWork(rel) {
  const abs = path.resolve(WORK, decodeURIComponent(rel || "").replace(/^\/+/, ""));
  if (abs !== WORK && !abs.startsWith(WORK + path.sep)) throw Object.assign(new Error("path outside /work"), { status: 400 });
  return abs;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && url.pathname === "/ls") {
      const dir = resolveInWork(url.searchParams.get("path") || "");
      const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return { name: e.name, dir: e.isDirectory(), size: st.size, mtime: st.mtime.toISOString() };
      });
      return send(200, entries);
    }
    if (url.pathname.startsWith("/file/")) {
      const abs = resolveInWork(url.pathname.slice("/file/".length));
      if (req.method === "GET") return send(200, fs.readFileSync(abs), "application/octet-stream");
      if (req.method === "PUT") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.concat(chunks));
        return send(200, { path: abs, size: fs.statSync(abs).size });
      }
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(e.status || (e.code === "ENOENT" ? 404 : 500), { error: e.message });
  }
}).listen(PORT, "0.0.0.0");
