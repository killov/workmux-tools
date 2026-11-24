// In-memory mock of the Slack Web API methods the plugin calls, for tests and QA without a workspace.
//
//   node test/mock-slack.mjs [port]   -> serves http://0.0.0.0:<port>/api/<method> (default 8090)
//   GET /_state                       -> the stored messages and app manifest
//
// Tokens are not checked beyond their prefix: xoxb-… is a bot token, xoxp-… a user token,
// xoxe… an app configuration token; any other or no token answers invalid_auth / not_authed.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const APP_ID = "A123";

function freshState() {
  return {
    seq: 0,
    messages: [], // { channel, ts, thread_ts?, user, bot_id?, text, reply_count?, reactions? }
    manifest: {
      display_information: { name: "WorkMux mock" },
      features: { bot_user: { display_name: "workmux-bot" } },
      oauth_config: { scopes: { bot: ["chat:write", "channels:history"] } },
      settings: {},
    },
  };
}

const CHANNELS = [
  { id: "C123", name: "general", is_private: false, is_member: true, num_members: 3 },
  { id: "G456", name: "secret", is_private: true, is_member: false, num_members: 2 },
];
const USERS = [
  { id: "U0BOT", name: "workmux-bot", real_name: "WorkMux", is_bot: true, deleted: false },
  { id: "U0ANNA", name: "anna", real_name: "Anna Example", is_bot: false, deleted: false },
];

function kindOf(token) {
  if (!token) return null;
  if (token.startsWith("xoxb-")) return "bot";
  if (token.startsWith("xoxp-")) return "user";
  if (token.startsWith("xoxe")) return "config";
  return "invalid";
}

function handle(state, method, p, kind) {
  const fail = (error, extra) => ({ ok: false, error, ...extra });
  if (!kind) return fail("not_authed");
  if (kind === "invalid") return fail("invalid_auth");
  if (method.startsWith("apps.manifest.") !== (kind === "config")) return fail("not_allowed_token_type");
  const find = (channel, ts) => state.messages.find((m) => m.channel === channel && m.ts === ts);
  const known = (channel) => CHANNELS.some((c) => c.id === channel);

  switch (method) {
    case "auth.test":
      return kind === "bot"
        ? { ok: true, url: "https://mock.slack.com/", team: "Mock Team", team_id: "T123", user: "workmux-bot", user_id: "U0BOT", bot_id: "B0BOT" }
        : { ok: true, url: "https://mock.slack.com/", team: "Mock Team", team_id: "T123", user: "anna", user_id: "U0ANNA" };
    case "chat.postMessage": {
      if (!known(p.channel)) return fail("channel_not_found");
      if (!p.text) return fail("no_text");
      if (p.thread_ts && !find(p.channel, p.thread_ts)) return fail("thread_not_found");
      const ts = `${1_700_000_000 + ++state.seq}.000100`;
      const m = { channel: p.channel, type: "message", ts, user: kind === "bot" ? "U0BOT" : "U0ANNA", text: p.text };
      if (kind === "bot") m.bot_id = "B0BOT";
      if (p.thread_ts) {
        m.thread_ts = p.thread_ts;
        const parent = find(p.channel, p.thread_ts);
        parent.thread_ts = parent.ts;
        parent.reply_count = (parent.reply_count || 0) + 1;
      }
      state.messages.push(m);
      return { ok: true, channel: p.channel, ts, message: m };
    }
    case "conversations.history": {
      if (!known(p.channel)) return fail("channel_not_found");
      const top = state.messages.filter((m) => m.channel === p.channel && (!m.thread_ts || m.thread_ts === m.ts));
      return { ok: true, messages: top.reverse().slice(0, Number(p.limit) || 100), has_more: false };
    }
    case "conversations.replies": {
      if (!find(p.channel, p.ts)) return fail("thread_not_found");
      const thread = state.messages.filter((m) => m.channel === p.channel && (m.ts === p.ts || m.thread_ts === p.ts));
      return { ok: true, messages: thread, has_more: false };
    }
    case "conversations.list":
      return { ok: true, channels: CHANNELS, response_metadata: { next_cursor: "" } };
    case "users.list":
      return { ok: true, members: USERS, response_metadata: { next_cursor: "" } };
    case "reactions.add": {
      const m = find(p.channel, p.timestamp);
      if (!m) return fail("message_not_found");
      m.reactions ??= [];
      if (m.reactions.some((r) => r.name === p.name)) return fail("already_reacted");
      m.reactions.push({ name: p.name, count: 1, users: ["U0BOT"] });
      return { ok: true };
    }
    case "search.messages": {
      if (kind !== "user") return fail("not_allowed_token_type");
      const matches = state.messages
        .filter((m) => m.text.includes(p.query))
        .map((m) => ({ channel: { id: m.channel, name: CHANNELS.find((c) => c.id === m.channel)?.name }, ts: m.ts, user: m.user, text: m.text, permalink: `https://mock.slack.com/archives/${m.channel}/p${m.ts.replace(".", "")}` }));
      return { ok: true, messages: { total: matches.length, matches, paging: { page: 1, pages: 1 } } };
    }
    case "apps.manifest.export":
      if (p.app_id !== APP_ID) return fail("app_not_found");
      return { ok: true, manifest: structuredClone(state.manifest) };
    case "apps.manifest.update": {
      if (p.app_id !== APP_ID) return fail("app_not_found");
      let manifest;
      try {
        manifest = JSON.parse(p.manifest);
      } catch {
        return fail("invalid_manifest");
      }
      const scopes = (m) => [...(m.oauth_config?.scopes?.bot || [])].sort().join(",");
      const permissions_updated = scopes(manifest) !== scopes(state.manifest);
      state.manifest = manifest;
      return { ok: true, app_id: APP_ID, permissions_updated };
    }
    default:
      return fail("unknown_method");
  }
}

async function readParams(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] || "").startsWith("application/json")) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw));
}

export function startMock(port = 0, host = "0.0.0.0") {
  const state = freshState();
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/_state") return send({ messages: state.messages, manifest: state.manifest, calls });
    if (!url.pathname.startsWith("/api/")) {
      res.writeHead(404).end();
      return;
    }
    const method = url.pathname.slice("/api/".length);
    const params = await readParams(req);
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    calls.push({ method, contentType: req.headers["content-type"] });
    send(handle(state, method, params, kindOf(token)));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, state, calls, port: server.address().port })));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startMock(Number(process.argv[2] || 8090));
  console.log(`mock Slack API on http://0.0.0.0:${port}/api/ (state: /_state)`);
}
