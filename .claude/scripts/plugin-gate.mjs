#!/usr/bin/env node
// GATE workflow `/resolve` pro workmux-tools: měřicí brána nad složkami pluginů.
//
//   node .claude/scripts/plugin-gate.mjs changed [--base <ref>]
//       Které složky pluginů se změnily (working tree + untracked, volitelně proti <ref>).
//   node .claude/scripts/plugin-gate.mjs validate <dir...>
//       Manifest proti schématu WorkMux + konvence repa (Dockerfile kontrakt, README tabulka).
//   node .claude/scripts/plugin-gate.mjs smoke <mcp-url> [--call <tool> --args '<json>']
//       MCP smoke test proti běžícímu kontejneru: /healthz, initialize, tools/list
//       (+ délka jmen <slug>__<tool>), volitelně jedno tools/call.
//   node .claude/scripts/plugin-gate.mjs docker <dir> [--call <tool> --args '<json>']
//       Když je po ruce `docker` (DOCKER_HOST): build → run → healthz → smoke → úklid.
//       Bez dockeru skončí exit 3 a řekne, ať se kontejner postaví přes MCP
//       `run_session_container` a pustí se `smoke` proti němu.
//
// Výstup: lidsky čitelné řádky + na konci jeden řádek `GATE_JSON {...}`. Exit 0 = zelená,
// 1 = červená, 2 = špatné použití, 3 = chybí docker (není to červená, jen jiná cesta).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mcpClient, resultText } from "./lib/mcp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Pořadí = priorita: `workmux-plugin.json` (WOR-757), `workmux-tool.json` server bere jen jako fallback.
const SCHEMAS = {
  // Dokud schéma na produkci neexistuje, validace se jen ohlásí jako přeskočená.
  "workmux-plugin.json": "https://app.workmux.com/schemas/workmux-plugin.v1.json",
  "workmux-tool.json": "https://app.workmux.com/schemas/workmux-tool.v1.json",
};
const MAX_TOOL_NAME = 64;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

const out = (line) => process.stdout.write(`${line}\n`);
function finish(result, code) {
  out(`GATE_JSON ${JSON.stringify(result)}`);
  process.exit(code);
}

function parseFlags(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      flags[k] = inline !== undefined ? inline : argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

/** Manifest, který WorkMux čte: `workmux-plugin.json`, jinak fallback `workmux-tool.json`. */
function manifestFile(dir) {
  return Object.keys(SCHEMAS).find((f) => fs.existsSync(path.join(ROOT, dir, f)));
}

/** Složka pluginu = adresář v kořeni repa s `workmux-plugin.json` nebo `workmux-tool.json`. */
function isPluginDir(dir) {
  return Boolean(manifestFile(dir));
}

function listPluginDirs() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .filter(isPluginDir)
    .sort();
}

// --- changed ---------------------------------------------------------------------------------

function changedFiles(base) {
  const files = new Set();
  for (const line of git("status", "--porcelain", "-uall").split("\n")) {
    if (!line.trim()) continue;
    const p = line.slice(3);
    files.add(p.includes(" -> ") ? p.split(" -> ")[1] : p);
  }
  if (base) for (const f of git("diff", "--name-only", `${base}...HEAD`).split("\n")) if (f) files.add(f);
  return [...files].map((f) => f.replace(/^"|"$/g, "")).sort();
}

/** Soubor s povrchem v běžícím pluginu — všechno kromě dokumentace (stejné pravidlo jako QA ve workflow). */
const hasRuntimeSurface = (f) => !/\.mdx?$/i.test(f) && !/(^|\/)docs?\//i.test(f);

function cmdChanged(flags) {
  const files = changedFiles(flags.base);
  const topDirs = (list) => [...new Set(list.filter((f) => f.includes("/") && !f.startsWith(".")).map((f) => f.split("/")[0]).filter(isDir))];
  const plugins = topDirs(files).filter(isPluginDir);
  // Image se staví jen tam, kde se změnilo něco jiného než dokumentace.
  const runtimePlugins = topDirs(files.filter(hasRuntimeSurface)).filter(isPluginDir);
  // Složka bez manifestu, do které přibyly soubory = nový plugin rozpracovaný bez manifestu.
  const orphanDirs = topDirs(files).filter((d) => !isPluginDir(d));
  out(`changed files: ${files.length}`);
  out(`changed plugins: ${plugins.join(", ") || "(none)"}`);
  out(`plugins to build: ${runtimePlugins.join(", ") || "(none)"}`);
  if (orphanDirs.length) out(`folders without a manifest: ${orphanDirs.join(", ")}`);
  finish({ cmd: "changed", ok: orphanDirs.length === 0, changedFiles: files, plugins, runtimePlugins, orphanDirs }, orphanDirs.length ? 1 : 0);
}
const isDir = (d) => {
  try {
    return fs.statSync(path.join(ROOT, d)).isDirectory();
  } catch {
    return false;
  }
};

// --- validate --------------------------------------------------------------------------------

async function loadSchema(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function makeAjv() {
  try {
    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    return new Ajv2020({ allErrors: true, strict: false });
  } catch {
    throw new Error("chybí ajv — spusť `npm ci --prefix .claude/scripts`");
  }
}

/** Konvence repa, které schéma nechytí (README „The contract" + CLAUDE.md). */
function conventionChecks(dir, manifest) {
  const errors = [];
  const warnings = [];
  const abs = path.join(ROOT, dir);
  if (manifest.slug && manifest.slug !== dir) warnings.push(`slug "${manifest.slug}" se liší od názvu složky "${dir}"`);
  if (!fs.existsSync(path.join(abs, "README.md"))) errors.push(`${dir}/README.md chybí`);
  const rootReadme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  if (!rootReadme.includes(`[\`${dir}\`](${dir}/)`)) errors.push(`kořenové README.md nemá řádek tabulky pro [\`${dir}\`](${dir}/)`);
  if (manifest.build) {
    const dockerfile = path.join(abs, manifest.build.context || ".", manifest.build.dockerfile || "Dockerfile");
    if (!fs.existsSync(dockerfile)) errors.push(`${path.relative(ROOT, dockerfile)} chybí`);
    else {
      const df = fs.readFileSync(dockerfile, "utf8");
      if (!/^\s*HEALTHCHECK\s/m.test(df)) errors.push(`${path.relative(ROOT, dockerfile)}: chybí HEALTHCHECK`);
      if (!/^\s*WORKDIR\s+\/work\s*$/m.test(df)) errors.push(`${path.relative(ROOT, dockerfile)}: chybí WORKDIR /work`);
      const users = [...df.matchAll(/^\s*USER\s+(\S+)/gm)].map((m) => m[1]);
      const lastUser = users.at(-1);
      if (!lastUser || lastUser === "root" || lastUser === "0") errors.push(`${path.relative(ROOT, dockerfile)}: kontejner neběží pod ne-root USER`);
      // Stažené binárky/releasy se pinují na verzi a ověřují sha256.
      if (/\b(curl|wget)\b[^\n]*https?:\/\//.test(df) && !/sha256sum|sha256|--checksum/.test(df)) {
        warnings.push(`${path.relative(ROOT, dockerfile)}: stahuje přes curl/wget bez ověření sha256`);
      }
    }
  }
  for (const s of manifest.secrets || []) {
    if (s.required === undefined) warnings.push(`secret ${s.env}: bez "required" je povinný a blokuje build — je to záměr?`);
  }
  return { errors, warnings };
}

async function cmdValidate(dirs) {
  if (!dirs.length) dirs = listPluginDirs();
  const ajv = await makeAjv();
  const schemaCache = new Map();
  const results = [];
  let ok = true;
  for (const dir of dirs) {
    const r = { dir, errors: [], warnings: [], skipped: [] };
    results.push(r);
    const manifests = Object.keys(SCHEMAS).filter((f) => fs.existsSync(path.join(ROOT, dir, f)));
    if (!manifests.length) r.errors.push(`${dir}: chybí workmux-plugin.json i workmux-tool.json`);
    if (manifests.length > 1) r.warnings.push(`${dir}: workmux-tool.json je jen fallback vedle workmux-plugin.json, smaž ho`);
    let primary = null;
    for (const file of manifests) {
      const rel = `${dir}/${file}`;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      } catch (e) {
        r.errors.push(`${rel}: neplatný JSON (${e.message})`);
        continue;
      }
      if (file === manifests[0]) primary = data;
      const url = SCHEMAS[file];
      if (data.$schema && data.$schema !== url) r.warnings.push(`${rel}: $schema je ${data.$schema}, čekám ${url}`);
      let validate = schemaCache.get(url);
      if (validate === undefined) {
        try {
          validate = ajv.compile(await loadSchema(url));
        } catch (e) {
          validate = null;
          r.skipped.push(`${rel}: schéma ${url} nejde načíst (${e.message}) — validace přeskočena`);
        }
        schemaCache.set(url, validate);
      } else if (validate === null) r.skipped.push(`${rel}: schéma ${url} nejde načíst — validace přeskočena`);
      if (validate && !validate(data)) {
        for (const err of validate.errors) r.errors.push(`${rel}: ${err.instancePath || "/"} ${err.message}${err.params?.additionalProperty ? ` (${err.params.additionalProperty})` : ""}`);
      }
    }
    if (primary) {
      const c = conventionChecks(dir, primary);
      r.errors.push(...c.errors);
      r.warnings.push(...c.warnings);
    }
    // Schéma `workmux-tool.json` je ověřené na produkci — když nejde načíst, je to červená
    // (nejde nic tvrdit). U `workmux-plugin.json` jen poznámka, schéma může zatím vracet 404.
    if (manifests[0] === "workmux-tool.json" && r.skipped.some((s) => s.includes("workmux-tool.json"))) r.errors.push(`${dir}: manifest nejde ověřit proti schématu (síť?)`);
    if (r.errors.length) ok = false;
    out(`${r.errors.length ? "FAIL" : "ok  "} ${dir}`);
    for (const e of r.errors) out(`  error: ${e}`);
    for (const w of r.warnings) out(`  warn:  ${w}`);
    for (const s of r.skipped) out(`  skip:  ${s}`);
  }
  finish({ cmd: "validate", ok, results }, ok ? 0 : 1);
}

// --- smoke -----------------------------------------------------------------------------------

async function smoke(url, flags) {
  const steps = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    return ok;
  };
  const timeoutS = Number(flags.timeout || 60);

  try {
    const h = await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(timeoutS * 1000) });
    step("GET /healthz", h.ok, `HTTP ${h.status}`);
  } catch (e) {
    step("GET /healthz", false, e.message);
  }

  const mcp = mcpClient(url, { timeoutS });
  let tools = [];
  try {
    const init = await mcp.initialize();
    const info = init.result?.serverInfo;
    if (!step("initialize", Boolean(info), init.error ? JSON.stringify(init.error) : `${info?.name} ${info?.version}, ${mcp.sessionId ? "Mcp-Session-Id ok" : "bez Mcp-Session-Id"}`)) {
      return { ok: false, steps, tools };
    }

    const list = await mcp.listTools();
    tools = list.result?.tools || [];
    step("tools/list", tools.length > 0, list.error ? JSON.stringify(list.error) : `${tools.length} toolů: ${tools.map((t) => t.name).join(", ")}`);

    const prefix = flags.slug ? `${flags.slug}__` : "";
    const bad = tools.filter((t) => !TOOL_NAME_RE.test(t.name) || `${prefix}${t.name}`.length > MAX_TOOL_NAME);
    step("jména toolů", bad.length === 0, bad.length ? `neplatná/dlouhá: ${bad.map((t) => t.name).join(", ")}` : `<slug>__<tool> ≤ ${MAX_TOOL_NAME} znaků`);

    if (flags.call) {
      const call = await mcp.callTool(flags.call, flags.args ? JSON.parse(flags.args) : {});
      step(`tools/call ${flags.call}`, Boolean(call.result) && call.result.isError !== true, call.error ? JSON.stringify(call.error) : resultText(call.result).slice(0, 500));
    }

    // Neznámá session → 404 (kontrakt bod 1), ať klient umí znovu initialize.
    const status = await mcp.unknownSessionStatus();
    step("neznámá Mcp-Session-Id → 404", status === 404, `HTTP ${status}`);
  } catch (e) {
    step("MCP", false, e.message);
  }
  return { ok: steps.every((s) => s.ok), steps, tools: tools.map((t) => t.name) };
}

async function cmdSmoke(url, flags) {
  if (!url) usage();
  const r = await smoke(url, flags);
  finish({ cmd: "smoke", url, ...r }, r.ok ? 0 : 1);
}

// --- docker ----------------------------------------------------------------------------------

function hasDocker() {
  return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).status === 0;
}

async function cmdDocker(dir, flags) {
  if (!dir) usage();
  if (!hasDocker()) {
    out("docker tu není (žádný DOCKER_HOST / daemon). Postav kontejner přes MCP run_session_container:");
    out(`  run_session_container({ name: "gate-${dir}", build: { context: "${dir}" }, ports: [8080], ttlMinutes: 30 })`);
    out(`  node .claude/scripts/plugin-gate.mjs smoke http://gate-${dir}:8080/mcp --slug ${dir}`);
    finish({ cmd: "docker", ok: null, dir, reason: "no-docker" }, 3);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, dir, manifestFile(dir)), "utf8"));
  const tag = `workmux-tools-gate/${dir}:latest`;
  const name = `gate-${dir}-${process.pid}`;
  const ctx = path.join(ROOT, dir, manifest.build?.context || ".");
  const build = spawnSync("docker", ["build", "-t", tag, "-f", path.join(ctx, manifest.build?.dockerfile || "Dockerfile"), ctx], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (build.status !== 0) {
    out("FAIL docker build");
    out((build.stdout + build.stderr).split("\n").slice(-40).join("\n"));
    finish({ cmd: "docker", ok: false, dir, step: "build" }, 1);
  }
  out("ok   docker build");
  const port = manifest.mcp.port;
  const run = spawnSync("docker", ["run", "-d", "--rm", "--name", name, "-P", tag], { encoding: "utf8" });
  if (run.status !== 0) finish({ cmd: "docker", ok: false, dir, step: "run", detail: run.stderr }, 1);
  try {
    const mapped = spawnSync("docker", ["port", name, `${port}/tcp`], { encoding: "utf8" }).stdout.split("\n")[0].trim();
    const hostPort = mapped.split(":").pop();
    const host = process.env.DOCKER_HOST?.startsWith("tcp://") ? new URL(process.env.DOCKER_HOST.replace("tcp:", "http:")).hostname : "127.0.0.1";
    const base = `http://${host}:${hostPort}`;
    const deadline = Date.now() + 60_000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      try {
        healthy = (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        /* ještě nestartuje */
      }
      if (!healthy) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) {
      out("FAIL kontejner neodpověděl na /healthz do 60 s");
      out(spawnSync("docker", ["logs", "--tail", "40", name], { encoding: "utf8" }).stderr);
      finish({ cmd: "docker", ok: false, dir, step: "healthz" }, 1);
    }
    const r = await smoke(`${base}${manifest.mcp.path || "/mcp"}`, { slug: manifest.slug, ...flags });
    const t0 = Date.now();
    spawnSync("docker", ["stop", "-t", "10", name]);
    const stopS = (Date.now() - t0) / 1000;
    const stopOk = stopS < 10;
    out(`${stopOk ? "ok  " : "FAIL"} SIGTERM → konec za ${stopS.toFixed(1)} s`);
    finish({ cmd: "docker", dir, ...r, ok: r.ok && stopOk, stopSeconds: stopS }, r.ok && stopOk ? 0 : 1);
  } finally {
    spawnSync("docker", ["rm", "-f", name]);
  }
}

function usage() {
  out("usage: plugin-gate.mjs changed [--base <ref>] | validate [dir...] | smoke <mcp-url> [--slug s] [--call tool --args json] | docker <dir> [--call tool --args json]");
  process.exit(2);
}

const { pos, flags } = parseFlags(process.argv.slice(2));
const [cmd, ...rest] = pos;
if (cmd === "changed") cmdChanged(flags);
else if (cmd === "validate") await cmdValidate(rest);
else if (cmd === "smoke") await cmdSmoke(rest[0], flags);
else if (cmd === "docker") await cmdDocker(rest[0], flags);
else usage();
