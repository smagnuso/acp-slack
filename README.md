# acp-slack

Bridges every running [acp-multiplex](https://github.com/ElleNajt/acp-multiplex)
session to a Slack thread, so any ACP agent (Claude Code, Codex, opencode,
etc.) you have wrapped with `acp-multiplex` shows up in Slack with the same
UX as `agent-shell-to-go`:

- One thread per agent session.
- Tool calls render as cards with status icons (▶ → ✅ / ❌).
- Tool output is collapsed by default; expand with 👀 / 📖 reactions.
- Permission prompts surface as `:lock:` messages; ✅ / ❌ reactions
  approve or deny.
- Slack-side messages flow back into the agent as user prompts.

Unlike `agent-shell-to-go`, the daemon attaches at the protocol layer.
It runs outside Emacs, so:

- Sessions get mirrored automatically — no per-buffer toggle.
- The bridge keeps running after Emacs closes, as long as the
  `acp-multiplex` proxy is alive.

## How it works

```
   $XDG_RUNTIME_DIR/        +-------------+        Slack
    acp-multiplex/   <----  |  acp-slack  |  ---->  Web API
       *.sock               |   daemon    |  <----  Socket Mode WS
                            +-------------+
                                  |
                          ~/.agent-shell/
                            slack/  (hidden originals)
                            slack-truncated/  (full output cache)
```

The daemon watches the socket directory and attaches as a *secondary
frontend* to each running proxy. The proxy replays cached history on
attach, then live-updates flow through.

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

   # acp-slack-only keys (ignored by Emacs):
   AUTHORIZED_USERS=U12345678,U23456789
   PER_PROJECT_CHANNELS=true
   SHOW_TOOL_OUTPUT=false
   HIDDEN_MESSAGES_DIR=~/.agent-shell/slack
   TRUNCATED_MESSAGES_DIR=~/.agent-shell/slack-truncated
   TODO_DIRECTORY=~/org/todo
   WEBSOCKET_STALE_THRESHOLD=7200
   DEBUG=false
   ```

3. **Build & run.**

   ```sh
   cd ~/dev/acp-slack
   npm install
   npm run build
   npm start
   ```

   Or `npm run dev` for build+start in one go. The daemon prints which
   socket directory it's watching and which authorized users it accepts.

4. **Optional systemd unit.** Drop in `~/.config/systemd/user/acp-slack.service`:

   ```ini
   [Unit]
   Description=acp-slack daemon
   After=network-online.target

   [Service]
   Type=simple
   ExecStart=%h/dev/acp-slack/node_modules/.bin/tsx %h/dev/acp-slack/src/index.ts
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

   Enable with `systemctl --user enable --now acp-slack`.

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
| `ACP_SOCKET_DIR`             | `$XDG_RUNTIME_DIR/acp-multiplex`     | Override if your sockets live elsewhere. |
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
