// WorkMux plugin: Slack Web API behind a streamable HTTP MCP endpoint.
//
// A thin server over the Web API instead of a proxy to Slack's own MCP server: that one only takes
// user tokens of approved clients, so it can neither act as the app's bot nor register Event
// Subscriptions (see README.md).
//
// Tokens, first match wins, decided per call:
//   bot:    HTTP header x-workmux-oauth-token (WorkMux OAuth connection "slack") -> env SLACK_BOT_TOKEN
//   user:   HTTP header x-workmux-slack-user-token ("slack-user") -> env SLACK_USER_TOKEN (search only)
//   config: env SLACK_APP_CONFIG_TOKEN + SLACK_APP_ID (events_subscribe / events_unsubscribe only)
// Tokens are never logged or returned; outputs are scrubbed of them.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------------------------
// Configuration

const env = process.env;
const API_BASE = env.SLACK_API_BASE || "https://slack.com/api/";
const HOST = env.HOST || "0.0.0.0";
const PORT = Number(env.PORT || 8080);
const MCP_PATH = env.MCP_PATH || "/mcp";
const VERSION = "0.1.0";
const API_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_S = 20;
const SESSION_IDLE_MS = Number(env.SESSION_IDLE_MINUTES || 60) * 60_000;
const MAX_SESSIONS = Number(env.MAX_SESSIONS || 16);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const BOT_HEADER = "x-workmux-oauth-token";
const USER_HEADER = "x-workmux-slack-user-token";

const log = (...args) => console.error(new Date().toISOString(), ...args);

// ---------------------------------------------------------------------------------------------
// Credentials

function headerToken(extra, name) {
  let v = extra?.requestInfo?.headers?.[name];
  if (Array.isArray(v)) v = v[0];
  if (typeof v !== "string") return null;
  v = v.trim().replace(/^Bearer\s+/i, "");
  return v || null;
}

function botAuth(extra) {
  const h = headerToken(extra, BOT_HEADER);
  if (h) return { source: "header", token: h };
  if (env.SLACK_BOT_TOKEN) return { source: "env", token: env.SLACK_BOT_TOKEN };
  return null;
}

function userAuth(extra) {
  const h = headerToken(extra, USER_HEADER);
  if (h) return { source: "header", token: h };
  if (env.SLACK_USER_TOKEN) return { source: "env", token: env.SLACK_USER_TOKEN };
  return null;
}

const configAuth = () => (env.SLACK_APP_CONFIG_TOKEN && env.SLACK_APP_ID ? { token: env.SLACK_APP_CONFIG_TOKEN, appId: env.SLACK_APP_ID } : null);

const SOURCE_TEXT = {
  header: `the token of the Slack OAuth connection WorkMux sent with this request (${BOT_HEADER} header)`,
  env: "the bot token in SLACK_BOT_TOKEN",
};

const NO_AUTH_TEXT = [
  "No Slack token is configured for this plugin, so it cannot call Slack.",
  "Ask the project owner to set one of these in WorkMux (Project settings → Plugins → Slack):",
  "- the Slack OAuth connection shared with the bot (preferred; WorkMux passes the app's bot token with every call),",
  "- the secret SLACK_BOT_TOKEN with the app's Bot User OAuth Token (xoxb-…, Slack app → OAuth & Permissions).",
  "Search additionally needs a user token: the Slack (user token) connection or the secret SLACK_USER_TOKEN with search:read.",
].join("\n");

const NO_SEARCH_TEXT =
  "search needs a Slack user token with the search:read scope (Slack does not let bot tokens search). Connect Slack (user token) in WorkMux or set the secret SLACK_USER_TOKEN (xoxp-…).";

// Slack tokens: xoxb/xoxp/xoxa/xoxe…, refresh tokens xoxe-…, config tokens xoxe.xoxp-…, app tokens xapp-….
const SECRET_RE = /\b(?:xox[a-z]?|xapp)[.-][A-Za-z0-9.-]{6,}/g;
const scrub = (text) => text.replace(SECRET_RE, "[redacted]");

const ERROR_HINTS = {
  not_in_channel: "The app is not a member of the channel: invite it in Slack with /invite @app.",
  channel_not_found: "Unknown channel id, or a private channel the app is not in; list_channels shows the ids it can see.",
  thread_not_found: "No thread with this thread_ts in the channel; use the ts of the thread's first message.",
  message_not_found: "No message with this timestamp in the channel.",
  missing_scope: "Add the scope to the Slack app (OAuth & Permissions) and reinstall it, then reconnect Slack in WorkMux.",
  invalid_auth: "The token is not valid; reconnect Slack in WorkMux or replace the secret.",
  not_authed: "No token reached Slack.",
  token_revoked: "The token was revoked; reconnect Slack in WorkMux or replace the secret.",
  token_expired: "The token expired (app configuration tokens last 12 hours).",
  account_inactive: "The app was uninstalled or the user deactivated; reinstall the app.",
  not_allowed_token_type: "This method does not take this kind of token.",
  invalid_name: "Unknown emoji name; pass it without colons, e.g. thumbsup.",
};

class ToolError extends Error {}

class SlackError extends ToolError {
  constructor(method, data) {
    const hint = ERROR_HINTS[data.error];
    const scopes = data.needed ? ` (needs scope ${data.needed}; the token has ${data.provided || "none"})` : "";
    super(`Slack ${method} failed: ${data.error}${scopes}${hint ? `. ${hint}` : ""}`);
    this.code = data.error;
  }
}

// ---------------------------------------------------------------------------------------------
// Slack Web API

// Write methods take a JSON body; read methods ignore one, so they get form fields.
async function slackCall(method, params, token, { json = false } = {}) {
  const fields = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const request = () =>
    fetch(new URL(method, API_BASE), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": json ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
      },
      body: json ? JSON.stringify(fields) : new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  let res;
  try {
    res = await request();
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 1);
      if (wait > MAX_RETRY_AFTER_S) throw new ToolError(`Slack ${method} is rate limited; try again in ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      res = await request();
      if (res.status === 429) throw new ToolError(`Slack ${method} is rate limited; try again in ${res.headers.get("retry-after") || "a few"} s`);
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(`Cannot reach Slack (${method}): ${scrub(err?.message || String(err))}`);
  }
  if (!res.ok) throw new ToolError(`Slack ${method} answered HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data) throw new ToolError(`Slack ${method} did not answer JSON`);
  if (!data.ok) throw new SlackError(method, data);
  return data;
}

function needBot(extra) {
  const auth = botAuth(extra);
  if (!auth) throw new ToolError(NO_AUTH_TEXT);
  return auth.token;
}

// Only the fields a bot needs; full Slack messages carry blocks, attachments and more.
const message = (m) => ({
  ts: m.ts,
  thread_ts: m.thread_ts,
  user: m.user,
  bot_id: m.bot_id,
  subtype: m.subtype,
  text: m.text,
  reply_count: m.reply_count,
  reactions: m.reactions?.map((r) => ({ name: r.name, count: r.count })),
  files: m.files?.map((f) => f.name),
});

const nextCursor = (data) => data.response_metadata?.next_cursor || undefined;

const clamp = (v, def, max) => Math.min(Math.max(Number.isInteger(v) ? v : def, 1), max);

function requireString(args, key) {
  if (typeof args[key] !== "string" || !args[key].trim()) throw new ToolError(`${key} is required`);
  return args[key].trim();
}

// ---------------------------------------------------------------------------------------------
// Events (WorkMux calls events_subscribe / events_unsubscribe itself, see README.md)

// Manifest kind -> Slack bot events, and the bot scope each bot event needs.
const KIND_EVENTS = {
  app_mention: ["app_mention"],
  message: ["message.channels", "message.groups", "message.im", "message.mpim"],
  reaction_added: ["reaction_added"],
};
const EVENT_SCOPES = {
  app_mention: "app_mentions:read",
  "message.channels": "channels:history",
  "message.groups": "groups:history",
  "message.im": "im:history",
  "message.mpim": "mpim:history",
  reaction_added: "reactions:read",
};

// WorkMux passes kinds as type strings; { type } objects are accepted too.
function botEventsOf(kinds) {
  const types = (Array.isArray(kinds) && kinds.length ? kinds : Object.keys(KIND_EVENTS)).map((k) => (typeof k === "string" ? k : k?.type));
  const events = new Set();
  for (const t of types) {
    if (typeof t !== "string" || !/^[a-z_]+(\.[a-z_]+)?$/.test(t)) throw new ToolError(`kinds: ${JSON.stringify(t)} is not a Slack event type`);
    for (const e of KIND_EVENTS[t] || [t]) events.add(e);
  }
  return [...events];
}

function checkUrl(url) {
  if (typeof url !== "string" || !/^https:\/\/\S+$/.test(url)) throw new ToolError("url must be the https:// webhook URL WorkMux created for this plugin");
  return url;
}

const subscribeSteps = (url, botEvents) => [
  "Open https://api.slack.com/apps and pick the Slack app this plugin uses (the one whose bot token WorkMux has).",
  "Event Subscriptions → turn on Enable Events.",
  `Request URL: paste ${url} — Slack checks it right away and WorkMux answers the check itself.`,
  `Subscribe to bot events → add ${botEvents.join(", ")} → Save Changes.`,
  "If Slack asks to reinstall the app (new scopes), reinstall it to the workspace.",
  "Basic Information → App Credentials → copy the Signing Secret into WorkMux as the plugin password SLACK_SIGNING_SECRET, if it is not set yet.",
  "Invite the app to the channels it should hear (/invite @app); it gets no message events from other channels.",
];

const unsubscribeSteps = (url) => [
  `Open https://api.slack.com/apps → the Slack app → Event Subscriptions → turn off Enable Events${typeof url === "string" ? ` (or replace the Request URL ${url})` : ""} → Save Changes.`,
];

const configFailure = (err) =>
  err instanceof SlackError && ["invalid_auth", "token_expired", "not_authed", "token_revoked"].includes(err.code)
    ? `SLACK_APP_CONFIG_TOKEN was refused (${err.code}); configuration tokens expire after 12 hours, so set a fresh one`
    : `Slack refused the change (${err instanceof SlackError ? err.code : scrub(err.message)})`;

async function exportManifest(config) {
  const data = await slackCall("apps.manifest.export", { app_id: config.appId }, config.token);
  return data.manifest;
}

const updateManifest = (config, manifest) => slackCall("apps.manifest.update", { app_id: config.appId, manifest: JSON.stringify(manifest) }, config.token);

async function eventsSubscribe(args) {
  const url = checkUrl(args.url);
  const botEvents = botEventsOf(args.kinds);
  const config = configAuth();
  if (!config) {
    return {
      registered: false,
      steps: subscribeSteps(url, botEvents),
      note: "Slack has no API to turn on Event Subscriptions with a bot token. A person has to paste the URL into the Slack app once, or set SLACK_APP_CONFIG_TOKEN and SLACK_APP_ID so the plugin does it.",
    };
  }
  try {
    const manifest = await exportManifest(config);
    manifest.settings ??= {};
    const current = manifest.settings.event_subscriptions || {};
    const events = [...new Set([...(current.bot_events || []), ...botEvents])];
    manifest.settings.event_subscriptions = { ...current, request_url: url, bot_events: events };
    manifest.oauth_config ??= {};
    manifest.oauth_config.scopes ??= {};
    manifest.oauth_config.scopes.bot = [...new Set([...(manifest.oauth_config.scopes.bot || []), ...events.map((e) => EVENT_SCOPES[e]).filter(Boolean)])];
    const updated = await updateManifest(config, manifest);
    log(`events_subscribe: app ${config.appId} subscribed to ${events.join(", ")}`);
    return {
      registered: true,
      subscription: config.appId,
      note: `Subscribed app ${config.appId} to ${events.join(", ")}.${updated.permissions_updated ? " The app got new scopes: reinstall it to the workspace (api.slack.com/apps → Install App), otherwise Slack sends no events." : ""}`,
    };
  } catch (err) {
    log(`events_subscribe: app ${config.appId} not updated: ${err instanceof SlackError ? err.code : err.message}`);
    return { registered: false, steps: subscribeSteps(url, botEvents), note: `Automatic registration failed: ${configFailure(err)}. Do the steps instead.` };
  }
}

async function eventsUnsubscribe(args) {
  const { url } = args;
  const config = configAuth();
  if (!config) return { ok: true, unregistered: false, steps: unsubscribeSteps(url), note: "Without SLACK_APP_CONFIG_TOKEN the plugin cannot change the Slack app; WorkMux stops accepting the URL either way." };
  try {
    const manifest = await exportManifest(config);
    const current = manifest.settings?.event_subscriptions;
    if (!current || current.request_url !== url) return { ok: true, unregistered: false, note: `App ${config.appId} does not send events to this URL; nothing to remove.` };
    delete manifest.settings.event_subscriptions;
    await updateManifest(config, manifest);
    log(`events_unsubscribe: app ${config.appId} unsubscribed`);
    return { ok: true, unregistered: true, note: `Turned off Event Subscriptions of app ${config.appId}.` };
  } catch (err) {
    log(`events_unsubscribe: app ${config.appId} not updated: ${err instanceof SlackError ? err.code : err.message}`);
    return { ok: true, unregistered: false, steps: unsubscribeSteps(url), note: `Automatic removal failed: ${configFailure(err)}.` };
  }
}

// ---------------------------------------------------------------------------------------------
// MCP tools

const INSTRUCTIONS = [
  "Slack through the Slack Web API, acting as the app's bot.",
  "auth_status shows the workspace and the bot's own user_id; list_channels and list_users give the ids the other tools take.",
  "send_message posts (thread_ts replies in a thread), read_channel and read_thread read, add_reaction reacts, search needs a user token.",
  "Answer a Slack event in its thread: send_message with channel and thread_ts from the event line; never answer your own or other bots' messages.",
  "events_subscribe and events_unsubscribe are called by WorkMux, not by bots.",
].join("\n");

const channelProp = { type: "string", description: "Channel id (C…, G… or D…), not the name; list_channels shows them" };
const cursorProp = { type: "string", description: "next_cursor of the previous page" };

const TOOLS = [
  {
    name: "send_message",
    title: "Send a Slack message",
    description: "Post a message to a channel or DM (chat.postMessage), or reply in a thread with thread_ts. Text is Slack mrkdwn: *bold*, _italic_, `code`, <@U123> mentions, <https://example.com|label> links. Returns {channel, ts, thread_ts}; pass thread_ts to reply in the same thread.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "text"],
      properties: {
        channel: channelProp,
        text: { type: "string", description: "Message text (mrkdwn)" },
        thread_ts: { type: "string", description: "ts of the thread's first message to reply in that thread" },
        reply_broadcast: { type: "boolean", description: "With thread_ts: also show the reply in the channel" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "read_channel",
    title: "Read a Slack channel",
    description: "Newest messages of a channel or DM first (conversations.history): ts, user, text, thread_ts, reply_count, reactions. Page with cursor; oldest/latest are ts bounds. Replies in threads are not included: read them with read_thread.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: {
        channel: channelProp,
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages per page (default 50)" },
        cursor: cursorProp,
        oldest: { type: "string", description: "Only messages after this ts" },
        latest: { type: "string", description: "Only messages before this ts" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "read_thread",
    title: "Read a Slack thread",
    description: "A thread (conversations.replies): its first message, then the replies, oldest first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "thread_ts"],
      properties: {
        channel: channelProp,
        thread_ts: { type: "string", description: "ts of the thread's first message" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Messages per page (default 100)" },
        cursor: cursorProp,
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_channels",
    title: "List Slack channels",
    description: "Channels the app can see (conversations.list): id, name, is_private, is_member, num_members. The app reads and gets events only where is_member is true.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        types: { type: "string", description: "Comma-separated: public_channel, private_channel, mpim, im (default public_channel,private_channel)" },
        exclude_archived: { type: "boolean", description: "Leave archived channels out (default true)" },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Channels per page (default 200)" },
        cursor: cursorProp,
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_users",
    title: "List Slack users",
    description: "Members of the workspace (users.list): id, name, real_name, is_bot, deleted. Mention a user in a message as <@id>.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Users per page (default 200)" },
        cursor: cursorProp,
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "search",
    title: "Search Slack messages",
    description: "Search messages (search.messages) with Slack's query syntax, e.g. \"deploy in:#ops from:@anna after:2026-01-01\". Needs a user token with search:read (Slack (user token) connection or SLACK_USER_TOKEN); finds what that user can see.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (default 20)" },
        page: { type: "integer", minimum: 1, description: "Page number (default 1)" },
        sort: { type: "string", enum: ["score", "timestamp"], description: "Order (default score)" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "add_reaction",
    title: "React to a Slack message",
    description: "Add an emoji reaction to a message (reactions.add). An existing reaction of the app counts as success.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "timestamp", "name"],
      properties: {
        channel: channelProp,
        timestamp: { type: "string", description: "ts of the message" },
        name: { type: "string", description: "Emoji name without colons, e.g. eyes, white_check_mark" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "auth_status",
    title: "Which Slack identity is used",
    description: "The workspace, the bot's own user_id and bot_id (auth.test) and which tokens are available (never their values). Without a token it explains how to connect Slack.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "events_subscribe",
    title: "Register the event webhook (WorkMux)",
    description: "Called by WorkMux, not by bots: points the Slack app's Event Subscriptions at the webhook url. With SLACK_APP_CONFIG_TOKEN and SLACK_APP_ID it edits the app manifest and returns {registered: true, subscription}; otherwise {registered: false, steps} for a person.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "https:// webhook URL of WorkMux" },
        kinds: { type: "array", items: { type: ["string", "object"] }, description: "Event kinds from the manifest (app_mention, message, reaction_added); default all" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "events_unsubscribe",
    title: "Remove the event webhook (WorkMux)",
    description: "Called by WorkMux, not by bots: turns off the Slack app's Event Subscriptions when they point at url (needs SLACK_APP_CONFIG_TOKEN and SLACK_APP_ID), otherwise returns steps for a person. Best effort, never fails because of Slack.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Webhook URL given to events_subscribe" },
        subscription: { type: ["string", "null"], description: "subscription returned by events_subscribe" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

const textResult = (value) => ({ content: [{ type: "text", text: scrub(JSON.stringify(value, null, 2)) }] });
const structuredResult = (value) => ({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] });
const errorResult = (text) => ({ content: [{ type: "text", text: scrub(text) }], isError: true });

async function callTool(name, a, extra) {
  const args = a || {};
  if (name === "send_message") {
    const channel = requireString(args, "channel");
    const text = requireString(args, "text");
    const r = await slackCall("chat.postMessage", { channel, text, thread_ts: args.thread_ts, reply_broadcast: args.thread_ts ? args.reply_broadcast : undefined }, needBot(extra), { json: true });
    return textResult({ channel: r.channel, ts: r.ts, thread_ts: args.thread_ts || r.ts });
  }
  if (name === "read_channel") {
    const channel = requireString(args, "channel");
    const r = await slackCall("conversations.history", { channel, limit: clamp(args.limit, 50, 200), cursor: args.cursor, oldest: args.oldest, latest: args.latest }, needBot(extra));
    return textResult({ channel, messages: r.messages.map(message), has_more: r.has_more, next_cursor: nextCursor(r) });
  }
  if (name === "read_thread") {
    const channel = requireString(args, "channel");
    const ts = requireString(args, "thread_ts");
    const r = await slackCall("conversations.replies", { channel, ts, limit: clamp(args.limit, 100, 200), cursor: args.cursor }, needBot(extra));
    return textResult({ channel, thread_ts: ts, messages: r.messages.map(message), has_more: r.has_more, next_cursor: nextCursor(r) });
  }
  if (name === "list_channels") {
    const r = await slackCall(
      "conversations.list",
      { types: args.types || "public_channel,private_channel", exclude_archived: args.exclude_archived ?? true, limit: clamp(args.limit, 200, 1000), cursor: args.cursor },
      needBot(extra),
    );
    const channels = r.channels.map((c) => ({ id: c.id, name: c.name, user: c.user, is_private: c.is_private, is_member: c.is_member, is_archived: c.is_archived || undefined, num_members: c.num_members }));
    return textResult({ channels, next_cursor: nextCursor(r) });
  }
  if (name === "list_users") {
    const r = await slackCall("users.list", { limit: clamp(args.limit, 200, 1000), cursor: args.cursor }, needBot(extra));
    const users = r.members.map((u) => ({ id: u.id, name: u.name, real_name: u.real_name || u.profile?.real_name, is_bot: u.is_bot, deleted: u.deleted }));
    return textResult({ users, next_cursor: nextCursor(r) });
  }
  if (name === "search") {
    const query = requireString(args, "query");
    const auth = userAuth(extra);
    if (!auth || auth.token.startsWith("xoxb-")) throw new ToolError(NO_SEARCH_TEXT);
    const r = await slackCall("search.messages", { query, count: clamp(args.count, 20, 100), page: args.page, sort: args.sort }, auth.token);
    const m = r.messages;
    const matches = m.matches.map((x) => ({ channel: x.channel?.id, channel_name: x.channel?.name, ts: x.ts, user: x.user, username: x.username, text: x.text, permalink: x.permalink }));
    return textResult({ total: m.total, page: m.paging?.page, pages: m.paging?.pages, matches });
  }
  if (name === "add_reaction") {
    const channel = requireString(args, "channel");
    const timestamp = requireString(args, "timestamp");
    const emoji = requireString(args, "name").replace(/^:|:$/g, "");
    try {
      await slackCall("reactions.add", { channel, timestamp, name: emoji }, needBot(extra), { json: true });
    } catch (err) {
      if (!(err instanceof SlackError && err.code === "already_reacted")) throw err;
    }
    return textResult({ ok: true, channel, timestamp, name: emoji });
  }
  if (name === "auth_status") {
    const auth = botAuth(extra);
    const available = { user_token: Boolean(userAuth(extra)), app_config_token: Boolean(configAuth()) };
    if (!auth) return textResult({ active: "none", description: NO_AUTH_TEXT, available });
    const r = await slackCall("auth.test", {}, auth.token);
    return textResult({ active: auth.source, description: SOURCE_TEXT[auth.source], team: r.team, team_id: r.team_id, url: r.url, user: r.user, user_id: r.user_id, bot_id: r.bot_id, available });
  }
  if (name === "events_subscribe") return structuredResult(await eventsSubscribe(args));
  if (name === "events_unsubscribe") return structuredResult(await eventsUnsubscribe(args));
  return errorResult(`Unknown tool ${name}`);
}

function createMcpServer() {
  const server = new Server({ name: "slack", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      return await callTool(req.params.name, req.params.arguments, extra);
    } catch (err) {
      if (err instanceof ToolError) return errorResult(err.message);
      log(`tool ${req.params.name} failed:`, scrub(String(err?.message)));
      return errorResult(`Internal error: ${err?.message}`);
    }
  });
  return server;
}

// ---------------------------------------------------------------------------------------------
// Sessions and HTTP

const sessions = new Map(); // id -> { transport, server, lastSeen }
let shuttingDown = false;

async function closeSession(id, reason) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  log(`session ${id} closed (${reason})`);
  await Promise.allSettled([s.transport.close(), s.server.close()]);
}

async function newSession(req, res, body) {
  if (sessions.size >= MAX_SESSIONS) {
    const [oldest] = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    if (oldest) await closeSession(oldest[0], "too many sessions");
  }
  const s = { lastSeen: Date.now() };
  s.transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      s.id = id;
      sessions.set(id, s);
      log(`session ${id} started`);
    },
  });
  s.transport.onclose = () => s.id && closeSession(s.id, "transport closed");
  s.server = createMcpServer();
  await s.server.connect(s.transport);
  await s.transport.handleRequest(req, res, body);
}

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
    if (url.pathname === "/healthz") return sendJson(res, shuttingDown ? 503 : 200, { ok: !shuttingDown, sessions: sessions.size });
    if (url.pathname !== MCP_PATH) return sendJson(res, 404, { error: "not found" });
    if (shuttingDown) return sendJson(res, 503, { jsonrpc: "2.0", error: { code: -32000, message: "server is shutting down" }, id: null });

    const body = req.method === "POST" ? await readBody(req) : undefined;
    const sid = req.headers["mcp-session-id"];
    if (sid) {
      const s = sessions.get(Array.isArray(sid) ? sid[0] : sid);
      if (!s) return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      s.lastSeen = Date.now();
      return await s.transport.handleRequest(req, res, body);
    }
    if (req.method === "POST" && body && !Array.isArray(body) && isInitializeRequest(body)) return await newSession(req, res, body);
    return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid Mcp-Session-Id header (send initialize first)" }, id: null });
  } catch (err) {
    log("request failed:", err?.message);
    sendJson(res, err.status || 500, { jsonrpc: "2.0", error: { code: err.rpcCode || -32603, message: err.message }, id: null });
  }
});

const idleTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_IDLE_MS) closeSession(id, "idle");
}, 60_000);
idleTimer.unref();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: shutting down`);
  setTimeout(() => process.exit(0), 4_000).unref();
  httpServer.close();
  httpServer.closeAllConnections?.();
  await Promise.allSettled([...sessions.keys()].map((id) => closeSession(id, signal)));
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------------------------------------------------------------------------------------------
// Start

httpServer.listen(PORT, HOST, () => log(`slack MCP on http://${HOST}:${PORT}${MCP_PATH}, Slack API ${new URL(API_BASE).origin}`));
