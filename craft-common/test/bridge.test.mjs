// Tests of the Craft bridge (server.mjs) against fake-cli.mjs: path confinement, inline exports, encode_mp3, session
// cleanup.
//
//   npm ci --prefix craft-common && node --test craft-common/test/bridge.test.mjs

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMON = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_CLI = path.join(COMMON, "test", "fake-cli.mjs");
const FAKE_LAME = path.join(COMMON, "test", "fake-lame.mjs");
const ACCEPT = "application/json, text/event-stream";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor(check, what, ms = 5_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

// A bridge in its own temp dir (server.mjs reads craft.json next to itself) with fake-cli.mjs as the engine.
async function startBridge({ engineRoots = true, encodeMp3 = false, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakecraft-"));
  fs.copyFileSync(path.join(COMMON, "server.mjs"), path.join(dir, "server.mjs"));
  fs.symlinkSync(path.join(COMMON, "node_modules"), path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "craft.json"), JSON.stringify({ app: "fakecraft", name: "FakeCraft", hideTools: [], callTimeoutMs: 10_000, engineRoots, encodeMp3, base64Formats: { png: "png" } }));
  const work = path.join(dir, "work");
  const pidFile = path.join(dir, "cli.pid");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, "server.mjs")], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), WORK_DIR: work, CRAFT_CLI: FAKE_CLI, FAKECRAFT_PIDFILE: pidFile, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const url = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${url}/healthz`).then((r) => r.ok, () => false), "the bridge to listen");
  return {
    dir,
    work,
    pidFile,
    url,
    get stderr() {
      return stderr;
    },
    async stop() {
      child.kill("SIGTERM");
      const code = await Promise.race([exited, delay(5_000).then(() => "timeout")]);
      fs.rmSync(dir, { recursive: true, force: true });
      assert.notEqual(code, "timeout", "the bridge did not exit within 5 s of SIGTERM");
    },
  };
}

async function post(bridge, body, { sessionId, accept = ACCEPT } = {}) {
  const res = await fetch(`${bridge.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // A request is answered as one SSE event, errors of the bridge itself as plain JSON.
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  const json = data ? JSON.parse(data.slice(6)) : text ? JSON.parse(text) : undefined;
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), json };
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

async function openSession(bridge) {
  const res = await post(bridge, initialize);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  await post(bridge, { jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: res.sessionId });
  let id = 1;
  return {
    id: res.sessionId,
    async list() {
      const r = await post(bridge, { jsonrpc: "2.0", id: ++id, method: "tools/list" }, { sessionId: res.sessionId });
      return r.json.result.tools.map((t) => t.name);
    },
    async call(name, args) {
      const r = await post(bridge, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }, { sessionId: res.sessionId });
      assert.equal(r.status, 200);
      assert.ok(r.json.result, JSON.stringify(r.json));
      return { ...r.json.result, text: r.json.result.content.map((c) => c.text).join("\n") };
    },
  };
}

const health = (bridge) => fetch(`${bridge.url}/healthz`).then((r) => r.json());

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const engineRoots of [true, false]) {
  describe(`paths (engineRoots ${engineRoots})`, () => {
    let bridge;
    let sess;
    before(async () => {
      bridge = await startBridge({ engineRoots });
      sess = await openSession(bridge);
    });
    after(() => bridge.stop());

    test("an absolute path under an unknown nested key is refused", async () => {
      const r = await sess.call("echo", { params: { src: "/etc/passwd" } });
      assert.equal(r.isError, true);
      assert.match(r.text, /outside/);
    });

    test("a relative file path in a nested step is refused outside /work", async () => {
      const r = await sess.call("echo", { params: { steps: [{ params: { file: "../x" } }] } });
      assert.equal(r.isError, true);
      assert.match(r.text, /echo\.params\.steps\[0\]\.params\.file .*outside/);
    });

    test("an unknown top-level key going up out of /work is refused", async () => {
      const r = await sess.call("echo", { target: "../../etc" });
      assert.equal(r.isError, true);
      assert.match(r.text, /echo\.target \(looks like a path\) .*outside/);
    });

    test("/work/..foo is inside /work", async () => {
      fs.writeFileSync(path.join(bridge.work, "..foo"), "x");
      const abs = await sess.call("echo", { path: `${bridge.work}/..foo` });
      assert.equal(abs.isError, undefined, abs.text);
      assert.equal(JSON.parse(abs.text).path, path.join(bridge.work, "..foo"));
      const rel = await sess.call("echo", { path: "..foo", params: { file: "..foo" } });
      assert.equal(rel.isError, undefined, rel.text);
      assert.deepEqual(JSON.parse(rel.text), { path: path.join(bridge.work, "..foo"), params: { file: "..foo" } });
    });

    test("a nested file path through a symlink out of /work is refused", async () => {
      fs.rmSync(path.join(bridge.work, "link"), { force: true });
      fs.symlinkSync("/etc", path.join(bridge.work, "link"));
      const r = await sess.call("echo", { params: { file: "link/x" } });
      assert.equal(r.isError, true);
      assert.match(r.text, /symlink/);
    });

    test("plain values pass unchanged: SVG path data, object ids, names", async () => {
      const args = { d: "M236 180 C226 160 246 150 236 130", params: { path: "path-3", name: "Layer 1", file: "", steps: [{ text: "a/b" }] } };
      const r = await sess.call("echo", args);
      assert.equal(r.isError, undefined, r.text);
      assert.deepEqual(JSON.parse(r.text), args);
    });
  });
}

describe("inline exports", () => {
  let bridge;
  let sess;
  before(async () => {
    bridge = await startBridge();
    sess = await openSession(bridge);
  });
  after(() => bridge.stop());

  const exports = () => fs.readdirSync(bridge.work).filter((f) => f.startsWith("export_"));

  test("file data that does not parse is dropped, never passed inline", async () => {
    const r = await sess.call("export_bad", {});
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /aGVsbG8gd29ybGQ|dataBase64/);
    assert.deepEqual(exports(), []);
  });

  test("a known format becomes a file in /work", async () => {
    const r = await sess.call("export_fmt", { format: "PNG" });
    assert.equal(r.isError, undefined, r.text);
    const out = JSON.parse(r.text);
    assert.equal(out.dataBase64, undefined);
    assert.match(out.path, /\.png$/);
    assert.equal(path.dirname(out.path), bridge.work);
    assert.equal(fs.readFileSync(out.path, "utf8"), "hi");
  });

  test("an unknown format is refused and writes no file", async () => {
    const before = exports();
    const r = await sess.call("export_fmt", { format: "exe" });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(r.text).dataBase64, undefined);
    assert.match(r.text, /unsupported export format \\"exe\\"/);
    assert.deepEqual(exports(), before);
  });

  test("a base64Formats key becomes a file also without a format", async () => {
    const r = await sess.call("export_png", {});
    assert.equal(r.isError, undefined, r.text);
    const out = JSON.parse(r.text);
    assert.equal(out.png, undefined);
    assert.equal(out.width, 2);
    assert.match(out.path, /\.png$/);
    assert.equal(fs.readFileSync(out.path, "latin1"), "\x89PNG\r\n\x1a\nhi");
  });

  test("base64Formats bytes that are not of the format are refused and write no file", async () => {
    const r = await sess.call("echo", { png: "aGk=" });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /aGk=/);
    assert.match(r.text, /inline file data is not png/);
    assert.deepEqual(fs.readdirSync(bridge.work).filter((f) => f.startsWith("echo-")), []);
  });
});

describe("encode_mp3", () => {
  let bridge;
  let sess;
  before(async () => {
    bridge = await startBridge({ encodeMp3: true, env: { CRAFT_LAME_BIN: FAKE_LAME } });
    sess = await openSession(bridge);
    fs.writeFileSync(path.join(bridge.work, "mix.wav"), "RIFF");
  });
  after(() => bridge.stop());

  test("is listed only with encodeMp3 in craft.json", async () => {
    assert.ok((await sess.list()).includes("encode_mp3"));
    const plain = await startBridge();
    try {
      assert.ok(!(await (await openSession(plain)).list()).includes("encode_mp3"));
    } finally {
      await plain.stop();
    }
  });

  test("writes <name>.mp3 next to the source by default", async () => {
    const r = await sess.call("encode_mp3", { path: "mix.wav" });
    assert.equal(r.isError, undefined, r.text);
    const out = path.join(bridge.work, "mix.mp3");
    assert.deepEqual(JSON.parse(r.text), { path: out, bytes: 11 });
    assert.equal(fs.readFileSync(out, "utf8"), "-b 192 RIFF");
  });

  test("passes the bit rate and an explicit out", async () => {
    const r = await sess.call("encode_mp3", { path: path.join(bridge.work, "mix.wav"), out: "sub/../x.MP3", bitrate_kbps: 320 });
    assert.equal(r.isError, undefined, r.text);
    assert.equal(fs.readFileSync(path.join(bridge.work, "x.MP3"), "utf8"), "-b 320 RIFF");
  });

  test("refuses paths outside /work, also through a symlink", async () => {
    fs.rmSync(path.join(bridge.work, "link"), { force: true });
    fs.symlinkSync(os.tmpdir(), path.join(bridge.work, "link"));
    for (const [args, re] of [
      [{ path: "/etc/passwd" }, /encode_mp3\.path .*outside/],
      [{ path: "mix.wav", out: "/tmp/x.mp3" }, /encode_mp3\.out .*outside/],
      [{ path: "mix.wav", out: "link/x.mp3" }, /encode_mp3\.out .*symlink/],
    ]) {
      const r = await sess.call("encode_mp3", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re);
    }
  });

  test("refuses a missing source, an out without .mp3 and a bad bit rate", async () => {
    for (const [args, re] of [
      [{ path: "none.wav" }, /path must be a WAV file/],
      [{ path: "mix.wav", out: "mix.wav" }, /must end with \.mp3/],
      [{ path: "mix.wav", bitrate_kbps: 1000 }, /bitrate_kbps/],
    ]) {
      const r = await sess.call("encode_mp3", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, re);
    }
  });

  test("a failing lame leaves no partial MP3 and its message is returned", async () => {
    fs.writeFileSync(path.join(bridge.work, "bad.wav"), "FAIL");
    const r = await sess.call("encode_mp3", { path: "bad.wav" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Unsupported data format/);
    assert.equal(fs.existsSync(path.join(bridge.work, "bad.mp3")), false);
  });
});

describe("failed initialize", () => {
  test("a refused initialize leaves no child and no session behind", async () => {
    const bridge = await startBridge();
    try {
      const res = await post(bridge, initialize, { accept: "application/json" });
      assert.equal(res.status, 406);
      const pid = Number(fs.readFileSync(bridge.pidFile, "utf8"));
      await waitFor(() => !alive(pid), `fake cli pid ${pid} to exit`);
      assert.equal((await health(bridge)).sessions, 0);
      const sess = await openSession(bridge);
      assert.equal((await sess.call("echo", { a: 1 })).text, '{"a":1}');
      assert.equal((await health(bridge)).sessions, 1);
    } finally {
      await bridge.stop();
    }
  });

  test("an engine that exits at start answers 500 and opens no session", async () => {
    const bridge = await startBridge({ env: { FAKECRAFT_MODE: "exit" } });
    try {
      const res = await post(bridge, initialize);
      assert.equal(res.status, 500);
      assert.match(res.json.error.message, /Cannot start FakeCraft/);
      assert.equal((await health(bridge)).sessions, 0);
    } finally {
      await bridge.stop();
    }
  });
});

describe("MAX_SESSIONS", () => {
  test("the least recently used session is closed with a 404 that says why", async () => {
    const bridge = await startBridge({ env: { MAX_SESSIONS: "1" } });
    try {
      const first = await openSession(bridge);
      const second = await openSession(bridge);
      const gone = await post(bridge, { jsonrpc: "2.0", id: 9, method: "tools/list" }, { sessionId: first.id });
      assert.equal(gone.status, 404);
      assert.match(gone.json.error.message, /MAX_SESSIONS \(1\)/);
      assert.match(bridge.stderr, /unsaved document changes of this session are lost/);
      const unknown = await post(bridge, { jsonrpc: "2.0", id: 9, method: "tools/list" }, { sessionId: "nope" });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.error.message, "Session not found");
      assert.equal((await second.call("echo", {})).text, "{}");
    } finally {
      await bridge.stop();
    }
  });
});
