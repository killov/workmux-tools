#!/usr/bin/env node
// Copies the shared Craft plugin base into every plugin folder with a craft.json.
//
//   node craft-common/sync.mjs [--check] [<dir>...]
//
// WorkMux builds each plugin from its own folder only, so a Craft plugin carries its own copy of server.mjs,
// meminfo.c, package.json and package-lock.json, and a Dockerfile rendered from Dockerfile.in with the values of its
// craft.json. Without <dir> every root folder with a craft.json is synced. --check writes nothing and exits 1
// when a generated file differs from what this script would write.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMON = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(COMMON);
const codeHeader = (file) => `// GENERATED from craft-common/${file} by craft-common/sync.mjs — do not edit, run the sync instead.\n`;
const DOCKERFILE_HEADER = "# GENERATED from craft-common/Dockerfile.in by craft-common/sync.mjs — do not edit, change craft.json and run the sync.\n";
const SHA256_RE = /^[0-9a-f]{64}$/;

const read = (file) => fs.readFileSync(path.join(COMMON, file), "utf8");

function loadCraft(dir) {
  const craft = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "craft.json"), "utf8"));
  const problems = [];
  if (craft.app !== dir) problems.push(`app "${craft.app}" must equal the folder name "${dir}"`);
  if (typeof craft.name !== "string" || !craft.name) problems.push("name is missing");
  if (!/^[\w.-]+\/[\w.-]+$/.test(craft.repo || "")) problems.push("repo must be <owner>/<repo> on GitHub");
  // Release candidates are not pinned: only a plain x.y.z release.
  if (!/^\d+\.\d+\.\d+$/.test(craft.version || "")) problems.push("version must be a release x.y.z");
  for (const arch of ["x86_64", "aarch64"]) {
    if (!SHA256_RE.test(craft.sha256?.[arch] || "")) problems.push(`sha256.${arch} must be the 64 hex digits from SHA256SUMS.txt`);
  }
  if (!Array.isArray(craft.aptPackages) || !craft.aptPackages.every((p) => /^[a-z0-9][a-z0-9.+-]+$/.test(p))) problems.push("aptPackages must be a list of Debian package names");
  if (!Array.isArray(craft.hideTools)) problems.push("hideTools must be a list of regular expressions");
  if (!Number.isInteger(craft.callTimeoutMs) || craft.callTimeoutMs <= 0) problems.push("callTimeoutMs must be a positive integer");
  if ("engineRoots" in craft && typeof craft.engineRoots !== "boolean") problems.push("engineRoots must be true or false");
  if ("fileKeys" in craft && !(Array.isArray(craft.fileKeys) && craft.fileKeys.every((k) => /^[A-Za-z_]\w*$/.test(k)))) problems.push("fileKeys must be a list of argument key names");
  if ("base64Keys" in craft && !(Array.isArray(craft.base64Keys) && craft.base64Keys.every((k) => /^[A-Za-z_]\w*$/.test(k)))) problems.push("base64Keys must be a list of JSON key names");
  if (problems.length) throw new Error(`${dir}/craft.json: ${problems.join("; ")}`);
  return craft;
}

function render(craft) {
  const values = {
    APP: craft.app,
    NAME: craft.name,
    REPO: craft.repo,
    VERSION: craft.version,
    SHA256_X86_64: craft.sha256.x86_64,
    SHA256_AARCH64: craft.sha256.aarch64,
    APT_PACKAGES: ["tini", ...craft.aptPackages].join(" "),
  };
  const dockerfile = read("Dockerfile.in").replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`Dockerfile.in: unknown placeholder ${m}`);
    return values[key];
  });
  return {
    "server.mjs": codeHeader("server.mjs") + read("server.mjs"),
    "meminfo.c": codeHeader("meminfo.c") + read("meminfo.c"),
    "package.json": read("package.json"),
    "package-lock.json": read("package-lock.json"),
    Dockerfile: DOCKERFILE_HEADER + dockerfile,
  };
}

const args = process.argv.slice(2);
const check = args.includes("--check");
let dirs = args.filter((a) => a !== "--check").map((d) => path.basename(path.resolve(ROOT, d)));
if (!dirs.length) {
  dirs = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, "craft.json")))
    .map((e) => e.name)
    .sort();
}

let stale = 0;
for (const dir of dirs) {
  let files;
  try {
    files = render(loadCraft(dir));
  } catch (err) {
    console.error(`error: ${err.message}`);
    stale++;
    continue;
  }
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(ROOT, dir, name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current === content) continue;
    if (check) {
      console.error(`out of sync: ${dir}/${name} (run node craft-common/sync.mjs)`);
      stale++;
    } else {
      fs.writeFileSync(file, content);
      console.log(`wrote ${dir}/${name}`);
    }
  }
}
process.exit(stale ? 1 : 0);
