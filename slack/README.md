# Slack — WorkMux plugin

Slack for WorkMux bots through the [Slack Web API](https://api.slack.com/web): send messages and thread replies,
read channels and threads, search, react, list channels and users. Slack events — a mention of the app, a new
message in its channels and DMs, a reaction — wake the bot: WorkMux creates the webhook and subscribes it through
the plugin's `events` section, no hand-made monitor. Bots see the tools as `slack__<tool>`.

## Why a server of its own

Slack's official MCP server only accepts user tokens of clients Slack has approved. It cannot act as the app's bot
(`xoxb` token) and has no way to set up Event Subscriptions, so it covers neither "the bot answers in Slack" nor
"a mention wakes the bot". This plugin is a thin Node server over the Web API (`fetch`, no other binary) with the few
methods a bot needs, plus the `events_subscribe` / `events_unsubscribe` tools WorkMux calls.

## Tools

| Tool | What it does |
| --- | --- |
| `send_message` | `chat.postMessage`: `{channel, text, thread_ts?, reply_broadcast?}` → `{channel, ts, thread_ts}`. Text is Slack mrkdwn. |
| `read_channel` | `conversations.history`: newest messages first, `{channel, limit?, cursor?, oldest?, latest?}`. |
| `read_thread` | `conversations.replies`: `{channel, thread_ts, limit?, cursor?}`, the parent first. |
| `list_channels` | `conversations.list`: id, name, is_private, is_member, num_members. |
| `list_users` | `users.list`: id, name, real_name, is_bot, deleted. |
| `search` | `search.messages` with Slack query syntax. Needs a user token with `search:read`; with a bot token only it says so. |
| `add_reaction` | `reactions.add`: `{channel, timestamp, name}`, emoji name without colons; an existing reaction is success. |
| `auth_status` | `auth.test`: workspace, the bot's `user_id` and `bot_id`, which token is used and whether a user token and an app configuration token are set (never their values). |
| `events_subscribe` | Called by WorkMux with `{url, kinds}`. See [Events](#events). |
| `events_unsubscribe` | Called by WorkMux with `{url, subscription}` when the plugin is detached. See [Events](#events). |

Messages come back trimmed to `ts`, `thread_ts`, `user`, `bot_id`, `subtype`, `text`, `reply_count`, `reactions`
and file names; lists page with `cursor` → `next_cursor`. The plugin works with no files.

## Set up the Slack app

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest** → pick the
   workspace → paste:

   ```yaml
   display_information:
     name: WorkMux
   features:
     bot_user:
       display_name: WorkMux
       always_online: true
   oauth_config:
     redirect_urls:
       - https://app.workmux.com/api/bot-connections/oauth/callback   # your WorkMux address; only for the OAuth connection
     scopes:
       bot:
         - chat:write
         - channels:read
         - channels:history
         - groups:read
         - groups:history
         - im:read
         - im:history
         - mpim:history
         - app_mentions:read
         - reactions:read
         - reactions:write
         - users:read
       user:
         - search:read
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

   Event Subscriptions are not in it on purpose: Slack checks the Request URL as soon as it is saved, and the URL
   exists only after the plugin is attached to a bot. `events_subscribe` adds them (see below).
2. **Install to Workspace**.
3. Invite the app to the channels it should read and hear: `/invite @WorkMux`.

## Connect it to WorkMux

Add the plugin (Project settings → Plugins → Add from repository, subdirectory `slack`), then:

- **Bot token** — either the Slack OAuth connection (provider `slack`, WorkMux sends the token in the
  `x-workmux-oauth-token` header of every call) or the secret `SLACK_BOT_TOKEN` with the **Bot User OAuth Token**
  (`xoxb-…`, OAuth & Permissions). The header wins when both are set.
- **Signing Secret** — the secret `SLACK_SIGNING_SECRET` (Basic Information → App Credentials → Signing Secret).
  WorkMux checks the `slack-v0` signature of every incoming event and answers Slack's `url_verification` with it; the
  plugin never reads it. It is optional, so the tools work without it (for sending and reading only); until it is
  set WorkMux shows the events as waiting for a secret and refuses incoming events (fail closed).
- **Search (optional)** — the Slack (user token) connection (provider `slack-user`, header
  `x-workmux-slack-user-token`) or the secret `SLACK_USER_TOKEN` (`xoxp-…` with `search:read`).
- **Automatic event registration (optional)** — the secrets `SLACK_APP_CONFIG_TOKEN` and `SLACK_APP_ID`. The
  token is an *app configuration token* (api.slack.com/apps → **Your App Configuration Tokens** → Generate Token): it
  can edit every app its creator manages in the workspace and **expires after 12 hours**, so it is meant for setting
  things up, not for keeping. Without it `events_subscribe` returns the steps for a person instead.

Tokens are never logged or returned; outputs are scrubbed of anything that looks like a Slack token
(`xox…`, `xapp-…`).

## Events

The manifest's `events` section subscribes to `app_mention`, `message` and `reaction_added`. When the plugin is
attached to a bot, WorkMux creates a webhook URL for it and calls `events_subscribe {url, kinds}`:

- **With `SLACK_APP_CONFIG_TOKEN` + `SLACK_APP_ID`:** `apps.manifest.export` → sets
  `settings.event_subscriptions.request_url` to `url` and adds the bot events (`app_mention`; `message.channels`,
  `message.groups`, `message.im`, `message.mpim`; `reaction_added`) and the scopes they need → `apps.manifest.update`
  → `{registered: true, subscription: "<app id>"}`. When Slack reports new scopes, `note` asks to reinstall the app.
- **Otherwise, or when Slack refuses the change** (expired config token, invalid manifest):
  `{registered: false, steps, note}`. Slack has no API to turn on Event Subscriptions with a bot token, so WorkMux
  shows the steps and the URL in the bot's plugin settings: Event Subscriptions → Enable Events → paste the URL as
  Request URL → Subscribe to bot events → Save Changes → reinstall when asked.

`events_unsubscribe {url, subscription}` is best effort: with the config token it removes `event_subscriptions` from
the app when they still point at `url`; otherwise it answers `ok` with the step to turn them off by hand. WorkMux
stops accepting the URL either way.

The event filter drops messages with a `bot_id` (the bot's own replies would wake it again) and edits, deletions and
other message subtypes. The line the bot gets is
`<type> channel=<id> ts=<ts> thread_ts=<ts> user=<id>: <text or reaction>`; the plugin's instructions tell the bot to
answer with `send_message {channel, thread_ts}` and to ignore its own messages. A mention in a channel arrives as
both `app_mention` and `message`; the bot answers the `app_mention` only.

The `events` section needs WorkMux with WOR-756 deployed; an older WorkMux rejects the manifest.

## Tests

`npm test` runs the server against `test/mock-slack.mjs`, an in-memory mock of the Slack methods above.
`SLACK_API_BASE` points the server at another API base, e.g. the mock for a manual try:

```bash
node test/mock-slack.mjs 8090 &
SLACK_API_BASE=http://127.0.0.1:8090/api/ SLACK_BOT_TOKEN=xoxb-test-dummy node server.mjs
```

The mock takes any `xoxb-…` token as a bot, `xoxp-…` as a user and `xoxe…` as a config token (app `A123`);
`GET /_state` shows its messages and app manifest. The tests are not part of the image.
