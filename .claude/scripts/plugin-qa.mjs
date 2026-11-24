#!/usr/bin/env node
// QA harness workflow `/resolve` pro workmux-tools: ukázková úloha přes MCP pluginu tak,
// jak ji udělá bot ve WorkMuxu — nahrát vstup do /work, zavolat tooly, zkontrolovat výstup.
//
//   node .claude/scripts/plugin-qa.mjs prepare <dir>
//       Vygeneruje build kontext `.workmux/qa/<dir>/` = kopie kontextu pluginu + Dockerfile
//       s přibaleným QA souborovým serverem (port 8099) a vypíše volání run_session_container.
//       Image pluginu musí mít `node` a `sh` a ENTRYPOINT/CMD v exec tvaru.
//   node .claude/scripts/plugin-qa.mjs put  <host> <lokální soubor> [cesta v /work]
//   node .claude/scripts/plugin-qa.mjs get  <host> <cesta v /work> <lokální soubor>
//   node .claude/scripts/plugin-qa.mjs ls   <host> [cesta v /work]
//   node .claude/scripts/plugin-qa.mjs tools <host>
//   node .claude/scripts/plugin-qa.mjs call <host> <tool> '<json args>' [--header k=v]
//   node .claude/scripts/plugin-qa.mjs steps <host> <steps.json> [--header k=v]
//       Víc volání v JEDNÉ MCP session (stavové tooly — design, otevřený dokument…):
//       steps.json = [{ "tool": "...", "args": {...} }, ...]; zastaví se na první chybě.
//
// <host> je DNS jméno QA kontejneru v session (např. `qa-gws`); MCP port/cesta se berou
// z manifestu přes `--dir <dir>` (default 8080 /mcp), souborový server je na :8099.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mcpClient, resultText } from "./lib/mcp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const FILES_PORT = 8099;
const out = (line) => process.stdout.write(`${line}\n`);

function parseFlags(argv) {
  const pos = [];
  const flags = { header: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const v = inline !== undefined ? inline : argv[++i];
    if (k === "header") flags.header.push(v);
    else flags[k] = v;
  }
  return { pos, flags };
}

function manifestOf(dir) {
  if (!dir) return { mcp: { port: 8080, path: "/mcp" } };
  return JSON.parse(fs.readFileSync(path.join(ROOT, dir, "workmux-tool.json"), "utf8"));
}

/** ENTRYPOINT + CMD posledního stage (exec tvar), ať QA image pustí server stejně jako produkce. */
function startCommand(dockerfile) {
  const lines = fs.readFileSync(dockerfile, "utf8").replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const lastFrom = lines.findLastIndex((l) => /^\s*FROM\s/i.test(l));
  const stage = lines.slice(lastFrom);
  const pick = (kw) => {
    const l = stage.findLast((x) => new RegExp(`^\\s*${kw}\\s`, "i").test(x));
    if (!l) return [];
    const raw = l.replace(new RegExp(`^\\s*${kw}\\s+`, "i"), "").trim();
    if (!raw.startsWith("[")) throw new Error(`${kw} není v exec tvaru (["..."]) — QA image ho neumí převzít`);
    return JSON.parse(raw);
  };
  const user = stage.findLast((x) => /^\s*USER\s/i.test(x))?.trim().split(/\s+/)[1] || "root";
  return { cmd: [...pick("ENTRYPOINT"), ...pick("CMD")], user };
}

function prepare(dir) {
  const manifest = manifestOf(dir);
  if (!manifest.build) throw new Error(`${dir}: manifest nemá build (plugin z hotového image) — QA image nejde odvodit`);
  const ctx = path.join(ROOT, dir, manifest.build.context || ".");
  const dockerfile = path.join(ctx, manifest.build.dockerfile || "Dockerfile");
  const target = path.join(ROOT, ".workmux", "qa", dir);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(ctx, target, { recursive: true, filter: (src) => !src.split(path.sep).includes("node_modules") });
  fs.copyFileSync(path.join(HERE, "qa-files.mjs"), path.join(target, "qa-files.mjs"));
  const { cmd, user } = startCommand(dockerfile);
  if (!cmd.length) throw new Error(`${dir}: Dockerfile nemá ENTRYPOINT ani CMD`);
  const qaDockerfile = `${fs.readFileSync(dockerfile, "utf8").trimEnd()}

# --- QA vrstva (/resolve, jen v session) -----------------------------------------------------
USER root
COPY qa-files.mjs /opt/qa/qa-files.mjs
USER ${user}
EXPOSE ${FILES_PORT}
ENTRYPOINT []
CMD ${JSON.stringify(["sh", "-c", 'node /opt/qa/qa-files.mjs & exec "$@"', "qa", ...cmd])}
`;
  const qaName = path.join(path.dirname(path.relative(ctx, dockerfile)), "Dockerfile.qa");
  fs.writeFileSync(path.join(target, qaName), qaDockerfile);
  const rel = path.relative(ROOT, target);
  out(`QA build kontext: ${rel} (Dockerfile ${qaName})`);
  out("Spusť přes MCP workmux:");
  out(`  run_session_container({ name: "qa-${dir}", build: { context: "${rel}", dockerfile: "${qaName}" }, ports: [${manifest.mcp.port}, ${FILES_PORT}], ttlMinutes: 60 })`);
  out(`pak: node .claude/scripts/plugin-qa.mjs tools qa-${dir} --dir ${dir}`);
}

const filesBase = (host) => `http://${host}:${FILES_PORT}`;
const mcpUrl = (host, dir) => {
  const m = manifestOf(dir).mcp;
  return `http://${host}:${m.port}${m.path || "/mcp"}`;
};

async function must(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function main() {
  const { pos, flags } = parseFlags(process.argv.slice(2));
  const [cmd, host, ...rest] = pos;
  switch (cmd) {
    case "prepare":
      return prepare(host);
    case "put": {
      const [local, remote = path.basename(local)] = rest;
      const res = await must(await fetch(`${filesBase(host)}/file/${encodeURI(remote)}`, { method: "PUT", body: fs.readFileSync(local) }));
      return out(JSON.stringify(await res.json()));
    }
    case "get": {
      const [remote, local] = rest;
      const res = await must(await fetch(`${filesBase(host)}/file/${encodeURI(remote.replace(/^\/work\/?/, ""))}`));
      fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
      return out(`${local} (${fs.statSync(local).size} B)`);
    }
    case "ls": {
      const res = await must(await fetch(`${filesBase(host)}/ls?path=${encodeURIComponent((rest[0] || "").replace(/^\/work\/?/, ""))}`));
      for (const e of await res.json()) out(`${e.dir ? "d" : "-"} ${String(e.size).padStart(10)}  ${e.mtime}  ${e.name}`);
      return;
    }
    case "tools":
    case "call":
    case "steps": {
      const headers = Object.fromEntries(flags.header.map((h) => h.split(/=(.*)/s).slice(0, 2)));
      const mcp = mcpClient(mcpUrl(host, flags.dir), { timeoutS: Number(flags.timeout || 300), headers });
      const init = await mcp.initialize();
      if (!init.result) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
      if (cmd === "tools") {
        const list = await mcp.listTools();
        for (const t of list.result?.tools || []) out(`${t.name}: ${(t.description || "").split("\n")[0]}\n  input: ${JSON.stringify(t.inputSchema)}`);
        return;
      }
      if (cmd === "steps") {
        const steps = JSON.parse(fs.readFileSync(rest[0], "utf8"));
        for (const [i, s] of steps.entries()) {
          const r = await mcp.callTool(s.tool, s.args || {});
          const text = r.error ? JSON.stringify(r.error) : resultText(r.result);
          out(`--- ${i + 1}/${steps.length} ${s.tool}${r.error || r.result?.isError ? " (CHYBA)" : ""}\n${text}`);
          if (r.error || r.result?.isError) {
            process.exitCode = 1;
            return;
          }
        }
        return;
      }
      const [tool, json = "{}"] = rest;
      const call = await mcp.callTool(tool, JSON.parse(json));
      if (call.error) throw new Error(`tools/call ${tool}: ${JSON.stringify(call.error)}`);
      out(resultText(call.result));
      if (call.result?.isError) {
        out("(isError: true)");
        process.exitCode = 1;
      }
      return;
    }
    default:
      out("usage: plugin-qa.mjs prepare <dir> | put <host> <file> [remote] | get <host> <remote> <file> | ls <host> [dir] | tools <host> [--dir d] | call <host> <tool> '<json>' [--dir d] [--header k=v] | steps <host> <steps.json> [--dir d]");
      process.exitCode = 2;
  }
}

main().catch((e) => {
  out(`chyba: ${e.message}`);
  process.exitCode = 1;
});
