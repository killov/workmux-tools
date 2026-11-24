// npm test: the MCP server against the mock Slack API (test/mock-slack.mjs).
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startMock } from "./mock-slack.mjs";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const BOT_TOKEN = "xoxb-test-dummy-token";
const HOOK_URL = "https://app.workmux.com/api/hooks/test-token";

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startPlugin(mockPort, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, PORT: String(port), HOST: "127.0.0.1", SLACK_API_BASE: `http://127.0.0.1:${mockPort}/api/`, ...extraEnv },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (c) => (logs += c));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { url: `http://127.0.0.1:${port}/mcp`, child, logs: () => logs };
}

async function connect(url, headers = {}) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

const json = (r) => JSON.parse(r.content[0].text);

describe("slack plugin", () => {
  let mock;
  let plugin;
  let client;
  before(async () => {
    mock = await startMock(0, "127.0.0.1");
    plugin = await startPlugin(mock.port);
    client = await connect(plugin.url, { "x-workmux-oauth-token": `Bearer ${BOT_TOKEN}` });
  });
  after(async () => {
    await client?.close();
    plugin?.child.kill("SIGTERM");
    mock?.server.close();
  });

  test("lists the tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["add_reaction", "auth_status", "events_subscribe", "events_unsubscribe", "list_channels", "list_users", "read_channel", "read_thread", "search", "send_message"]);
  });

  test("unknown session answers 404", async () => {
    const res = await fetch(plugin.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 404);
  });

  test("auth_status uses the header token without returning it", async () => {
    const r = await client.callTool({ name: "auth_status", arguments: {} });
    const s = json(r);
    assert.equal(s.active, "header");
    assert.equal(s.user_id, "U0BOT");
    assert.equal(s.team_id, "T123");
    assert.ok(!r.content[0].text.includes(BOT_TOKEN));
  });

  test("sends a message, replies in its thread and reads the thread", async () => {
    const first = json(await client.callTool({ name: "send_message", arguments: { channel: "C123", text: "hello from QA" } }));
    assert.equal(first.thread_ts, first.ts);
    const reply = json(await client.callTool({ name: "send_message", arguments: { channel: "C123", text: "reply", thread_ts: first.ts } }));
    assert.equal(reply.thread_ts, first.ts);
    const thread = json(await client.callTool({ name: "read_thread", arguments: { channel: "C123", thread_ts: first.ts } }));
    assert.deepEqual(thread.messages.map((m) => m.text), ["hello from QA", "reply"]);
    const history = json(await client.callTool({ name: "read_channel", arguments: { channel: "C123" } }));
    assert.equal(history.messages[0].reply_count, 1);
    assert.equal(mock.calls.find((c) => c.method === "chat.postMessage").contentType, "application/json; charset=utf-8");
    assert.equal(mock.calls.find((c) => c.method === "conversations.history").contentType, "application/x-www-form-urlencoded");
  });

  test("adds a reaction twice without an error", async () => {
    const { ts } = json(await client.callTool({ name: "send_message", arguments: { channel: "C123", text: "react to me" } }));
    for (const name of [":eyes:", "eyes"]) {
      const r = await client.callTool({ name: "add_reaction", arguments: { channel: "C123", timestamp: ts, name } });
      assert.ok(!r.isError, r.content[0].text);
    }
  });

  test("lists channels and users", async () => {
    const { channels } = json(await client.callTool({ name: "list_channels", arguments: {} }));
    assert.equal(channels[0].id, "C123");
    const { users } = json(await client.callTool({ name: "list_users", arguments: {} }));
    assert.ok(users.some((u) => u.id === "U0ANNA"));
  });

  test("Slack errors come back with a hint", async () => {
    const r = await client.callTool({ name: "read_channel", arguments: { channel: "C999" } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /channel_not_found/);
  });

  test("search without a user token explains search:read", async () => {
    const r = await client.callTool({ name: "search", arguments: { query: "hello" } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /search:read/);
  });

  test("search with a user token header", async () => {
    const userClient = await connect(plugin.url, { "x-workmux-oauth-token": BOT_TOKEN, "x-workmux-slack-user-token": "xoxp-test-user" });
    const r = json(await userClient.callTool({ name: "search", arguments: { query: "hello" } }));
    assert.equal(r.matches[0].text, "hello from QA");
    await userClient.close();
  });

  test("events_subscribe without a config token returns steps with the url", async () => {
    const r = await client.callTool({ name: "events_subscribe", arguments: { url: HOOK_URL, kinds: ["app_mention", "message"] } });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent.registered, false);
    const steps = r.structuredContent.steps.join("\n");
    for (const s of [HOOK_URL, "app_mention", "message.channels", "message.im"]) assert.ok(steps.includes(s), s);
    assert.ok(!steps.includes("reaction_added"));
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  });

  test("events_subscribe refuses a non-https url", async () => {
    const r = await client.callTool({ name: "events_subscribe", arguments: { url: "http://example.com/hook", kinds: ["message"] } });
    assert.ok(r.isError);
  });

  test("events_unsubscribe without a config token is ok with steps", async () => {
    const r = await client.callTool({ name: "events_unsubscribe", arguments: { url: HOOK_URL, subscription: null } });
    assert.ok(!r.isError);
    assert.equal(r.structuredContent.ok, true);
    assert.equal(r.structuredContent.unregistered, false);
    assert.ok(r.structuredContent.steps[0].includes(HOOK_URL));
  });

  test("no token: tools explain how to connect Slack", async () => {
    const bare = await connect(plugin.url);
    const s = json(await bare.callTool({ name: "auth_status", arguments: {} }));
    assert.equal(s.active, "none");
    const r = await bare.callTool({ name: "send_message", arguments: { channel: "C123", text: "x" } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /SLACK_BOT_TOKEN/);
    await bare.close();
  });

  test("logs never contain the token", () => {
    assert.ok(!plugin.logs().includes(BOT_TOKEN));
  });
});

describe("slack plugin with an app configuration token", () => {
  let mock;
  let plugin;
  let client;
  before(async () => {
    mock = await startMock(0, "127.0.0.1");
    plugin = await startPlugin(mock.port, { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_CONFIG_TOKEN: "xoxe.xoxp-1-dummy", SLACK_APP_ID: "A123" });
    client = await connect(plugin.url);
  });
  after(async () => {
    await client?.close();
    plugin?.child.kill("SIGTERM");
    mock?.server.close();
  });

  test("auth_status falls back to SLACK_BOT_TOKEN", async () => {
    const s = json(await client.callTool({ name: "auth_status", arguments: {} }));
    assert.equal(s.active, "env");
    assert.equal(s.available.app_config_token, true);
  });

  test("events_subscribe registers the url in the app manifest", async () => {
    const r = await client.callTool({ name: "events_subscribe", arguments: { url: HOOK_URL, kinds: ["app_mention", "message", "reaction_added"] } });
    assert.equal(r.structuredContent.registered, true, r.content[0].text);
    assert.equal(r.structuredContent.subscription, "A123");
    assert.match(r.structuredContent.note, /reinstall/);
    const es = mock.state.manifest.settings.event_subscriptions;
    assert.equal(es.request_url, HOOK_URL);
    assert.deepEqual(es.bot_events, ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim", "reaction_added"]);
    assert.ok(mock.state.manifest.oauth_config.scopes.bot.includes("app_mentions:read"));
  });

  test("events_unsubscribe of another url leaves the app alone", async () => {
    const r = await client.callTool({ name: "events_unsubscribe", arguments: { url: "https://app.workmux.com/api/hooks/other", subscription: "A123" } });
    assert.equal(r.structuredContent.unregistered, false);
    assert.equal(mock.state.manifest.settings.event_subscriptions.request_url, HOOK_URL);
  });

  test("events_unsubscribe removes the subscription", async () => {
    const r = await client.callTool({ name: "events_unsubscribe", arguments: { url: HOOK_URL, subscription: "A123" } });
    assert.equal(r.structuredContent.unregistered, true, r.content[0].text);
    assert.equal(mock.state.manifest.settings.event_subscriptions, undefined);
  });

  test("a refused config token falls back to steps", async () => {
    const bad = await startPlugin(mock.port, { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_CONFIG_TOKEN: "bogus-config", SLACK_APP_ID: "A123" });
    const c = await connect(bad.url);
    const r = await c.callTool({ name: "events_subscribe", arguments: { url: HOOK_URL, kinds: ["message"] } });
    assert.equal(r.structuredContent.registered, false);
    assert.match(r.structuredContent.note, /invalid_auth/);
    assert.ok(r.structuredContent.steps.some((s) => s.includes(HOOK_URL)));
    await c.close();
    bad.child.kill("SIGTERM");
  });
});
