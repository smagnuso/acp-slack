# acp-hydra-slack

Bridges every active [acp-hydra](https://github.com/smagnuso/acp-hydra)
session to a Slack thread, so any ACP agent (Claude Code, Codex, Gemini,
etc.) running through hydra shows up in Slack with the same UX as
`agent-shell-to-go`:

- One thread per agent session.
- Tool calls render as cards with status icons (▶ → ✅ / ❌).
- Tool output is collapsed by default; expand with 👀 / 📖 reactions.
- Permission prompts surface as `:lock:` messages; ✅ / ❌ reactions
  approve or deny.
- Slack-side messages flow back into the agent as user prompts.

The bridge runs as a hydra extension (or standalone), polls hydra's
REST API for active sessions, and attaches over WSS to each one.

## How it works

```
                 hydra REST  +-------------+        Slack
       /v1/sessions   <----  |  acp-hydra-slack  |  ---->  Web API
                             |   daemon    |  <----  Socket Mode WS
       hydra WSS      <----> |             |
       /acp                  +-------------+
                                    |
                            ~/.agent-shell/
                              slack/  (hidden originals)
                              slack-truncated/  (full output cache)
```

The daemon polls `GET /v1/sessions` on hydra (default every 2s) and, for
each new session id it sees, opens a WebSocket to hydra's `/acp`
endpoint and sends `session/attach` with `role: "controller"`. Hydra
replays the session's history on attach, then live notifications flow
through. Slack-side prompts are forwarded back via `session/prompt`.

## Setup

1. **Slack app.** Create a Slack app with these scopes:
   - Bot scopes: `chat:write`, `chat:write.customize`,
     `reactions:read`, `reactions:write`, `files:read`, `channels:history`,
     `groups:history`, `im:history`, `mpim:history`, `users:read`.
   - Enable **Socket Mode** and generate an `xapp-...` app-level token
     with `connections:write`.
   - Subscribe to events: `message.channels`, `message.groups`,
     `message.im`, `reaction_added`, `reaction_removed`.
   - Install the app to your workspace and grab the bot token (`xoxb-...`).
2. **Config file.** Place credentials at `~/.agent-shell-to-go.conf` (the
   same file `agent-shell-to-go.el` reads, so the two can share):

   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_CHANNEL_ID=C0123456789

   # acp-hydra-slack-only keys (ignored by Emacs):
   AUTHORIZED_USERS=U12345678,U23456789
   PER_PROJECT_CHANNELS=true
   SHOW_TOOL_OUTPUT=false
   HIDDEN_MESSAGES_DIR=~/.agent-shell/slack
   TRUNCATED_MESSAGES_DIR=~/.agent-shell/slack-truncated
   TODO_DIRECTORY=~/org/todo
   WEBSOCKET_STALE_THRESHOLD=7200
   DEBUG=false
   ```

3. **Build.**

   ```sh
   cd ~/dev/acp-hydra-slack
   npm install
   npm run build
   ```

4. **Run as a hydra extension (recommended).** Add an entry to your
   `~/.acp-hydra/config.json`:

   ```json
   {
     "extensions": [
       {
         "name": "acp-hydra-slack",
         "command": ["node", "/home/you/dev/acp-hydra-slack/dist/index.js"],
         "enabled": true
       }
     ]
   }
   ```

   On `acp-hydra daemon start`, hydra spawns acp-hydra-slack with these env
   vars set: `ACP_HYDRA_DAEMON_URL`, `ACP_HYDRA_TOKEN`, `ACP_HYDRA_WS_URL`.
   acp-hydra-slack uses them to discover and attach to sessions. Stdout/stderr
   land in `~/.acp-hydra/extensions/acp-hydra-slack.log`.

5. **Run standalone (alternative).** Set `HYDRA_DAEMON_URL` and
   `HYDRA_TOKEN` in `~/.agent-shell-to-go.conf` (or export them as env
   vars), then:

   ```sh
   npm start
   ```

   The daemon prints which hydra it's polling and which authorized users
   it accepts.

## Configuration keys

| Key                          | Default                              | Notes |
|------------------------------|--------------------------------------|-------|
| `SLACK_BOT_TOKEN`            | (required)                           | `xoxb-...` |
| `SLACK_APP_TOKEN`            | (required)                           | `xapp-...` |
| `SLACK_CHANNEL_ID`           | none                                 | Default channel when per-project disabled or no mapping. |
| `AUTHORIZED_USERS`           | empty                                | Comma-separated Slack user IDs. Empty = inbound disabled. |
| `PER_PROJECT_CHANNELS`       | `true`                               | Look up channel per session cwd in the channel map. |
| `CHANNEL_PREFIX`             | empty                                | Reserved for auto-create flows; unused for now. |
| `CHANNELS_FILE`              | `~/.agent-shell/slack-channels.json` | JSON map of cwd → channel ID. |
| `SHOW_TOOL_OUTPUT`           | `false`                              | If true, include tool body inline (still truncated). |
| `UPLOAD_TRANSCRIPT_ON_END`   | `true`                               | When the multiplex socket closes, upload the thread's contents as a markdown file attached to the same thread. Set to `false` to disable. |
| `HIDDEN_MESSAGES_DIR`        | `~/.agent-shell/slack`               | Where 🙈-hidden message originals go. |
| `TRUNCATED_MESSAGES_DIR`     | `~/.agent-shell/slack-truncated`     | Where full tool outputs cache for 📖 expand. |
| `TODO_DIRECTORY`             | `~/org/todo`                         | Where bookmark reactions write TODO files. |
| `WEBSOCKET_STALE_THRESHOLD`  | `7200`                               | Seconds of socket silence before warning is logged. |
| `BACKFILL_HISTORY`           | `false`                              | If true, replay the proxy's cached history into Slack on attach. Off by default — replays trip Slack rate limits and create noise. |
| `LIVE_QUIET_MS`              | `2000`                               | Inbound silence (ms) needed before considering an attach "live" when `BACKFILL_HISTORY=false`. |
| `IMAGE_UPLOAD_RATE_LIMIT`    | `30`                                 | Reserved. |
| `IMAGE_UPLOAD_RATE_WINDOW`   | `60`                                 | Reserved. |
| `HYDRA_DAEMON_URL`           | `http://127.0.0.1:8765`              | Where to reach the hydra daemon. Set automatically when run as a hydra extension. |
| `HYDRA_WS_URL`               | derived from `HYDRA_DAEMON_URL`      | WebSocket endpoint for ACP attach. Defaults to `ws[s]://<host>:<port>/acp`. |
| `HYDRA_TOKEN`                | (required)                           | Bearer token for hydra. Set automatically when run as a hydra extension. |
| `HYDRA_POLL_INTERVAL_MS`     | `2000`                               | How often to poll hydra for session changes. |
| `DEBUG`                      | `false`                              | Verbose logging. |

## Reactions

| Reaction                                     | Action |
|---------------------------------------------|--------|
| `:white_check_mark:` / `:+1:` / `:star:` | Approve once (picks the agent's `allow_once` option) |
| `:unlock:`                                  | Approve always (picks `allow_always` when offered, otherwise falls back to `allow_once`) |
| `:x:` / `:-1:`                              | Deny |
| `:stop_sign:` / `:octagonal_sign:` / `:no_entry:` / `:no_entry_sign:` / `:stop:` | Cancel — react on the active turn spinner to send `session/cancel` to the agent. Ignored on any other message. |
| `:see_no_evil:` / `:no_bell:`               | Hide message (toggle to restore) |
| `:eyes:`                                    | Expand truncated tool output |
| `:book:` / `:open_book:`                    | Expand full tool output |
| `:heart:` (and friends)                     | Forward as positive feedback to agent |
| `:bookmark:`                                | Save message text as an org TODO |

## Slash-style commands

`!debug` posted in a thread replies with the session's debug info
(socket path, sessionId, last-frame time).

## Tests

```
npm test
```

Runs the formatter, ndjson, and reaction-map tests with the built-in
Node test runner.

## Out of scope

- Outbound image upload via file watcher (agent-shell-to-go has this;
  the daemon doesn't yet).
- Transcript upload at session end (agent-shell already writes
  transcripts; the daemon doesn't duplicate the work).
- mDNS service discovery for sockets across hosts.
- True ACP-to-ACP bridging (different project).

## Status

Functional, in daily use, but rough around the edges. Open issues at
the project repo.
