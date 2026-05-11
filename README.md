# hydra-acp-slack

Bridges every active [hydra-acp](https://github.com/smagnuso/hydra-acp)
session to a Slack thread, so any ACP agent (Claude Code, Codex, Gemini,
etc.) running through hydra shows up in Slack:

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
       /v1/sessions   <----  |  hydra-acp-slack  |  ---->  Web API
                             |   daemon    |  <----  Socket Mode WS
       hydra WSS      <----> |             |
       /acp                  +-------------+
                                    |
                            ~/.hydra-acp-slack/
                              hidden/     (hidden originals)
                              truncated/  (full output cache)
                              channels.json  (cwd → channel map)
```

The daemon polls `GET /v1/sessions` on hydra (default every 2s) and, for
each new session id it sees, opens a WebSocket to hydra's `/acp`
endpoint and sends `session/attach`. Hydra replays the session's history
on attach, then live notifications flow through. Slack-side prompts are
forwarded back via `session/prompt`.

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
2. **Config file.** Place credentials at `~/.hydra-acp-slack.conf`:

   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_CHANNEL_ID=C0123456789

   AUTHORIZED_USERS=U12345678,U23456789
   PER_PROJECT_CHANNELS=true
   SHOW_TOOL_OUTPUT=false
   HIDDEN_MESSAGES_DIR=~/.hydra-acp-slack/hidden
   TRUNCATED_MESSAGES_DIR=~/.hydra-acp-slack/truncated
   TODO_DIRECTORY=~/org/todo
   WEBSOCKET_STALE_THRESHOLD=7200
   DEBUG=false
   ```

3. **Install or build.**

   From npm (recommended once published):

   ```sh
   npm install -g @hydra-acp/slack
   ```

   This drops an `hydra-acp-slack` binary on your PATH.

   Or from source:

   ```sh
   git clone https://github.com/smagnuso/hydra-acp-slack.git ~/dev/hydra-acp-slack
   cd ~/dev/hydra-acp-slack
   npm install
   npm run build
   ```

4. **Run as a hydra extension (recommended).** Register the extension
   with hydra. If installed via npm:

   ```sh
   hydra-acp extensions add hydra-acp-slack --command hydra-acp-slack
   ```

   Or pointed at a local build:

   ```sh
   hydra-acp extensions add hydra-acp-slack \
     --command node \
     --args ~/dev/hydra-acp-slack/dist/index.js
   ```

   That writes the equivalent entry into `~/.hydra-acp/config.json`:

   ```json
   {
     "extensions": {
       "hydra-acp-slack": {
         "command": ["node"],
         "args": ["/home/you/dev/hydra-acp-slack/dist/index.js"],
         "enabled": true
       }
     }
   }
   ```

   On `hydra-acp daemon start`, hydra spawns hydra-acp-slack with these env
   vars set: `HYDRA_ACP_DAEMON_URL`, `HYDRA_ACP_TOKEN`, `HYDRA_ACP_WS_URL`.
   hydra-acp-slack uses them to discover and attach to sessions. Stdout/stderr
   land in `~/.hydra-acp/extensions/hydra-acp-slack.log`. Lifecycle is managed
   with `hydra-acp extensions start|stop|restart hydra-acp-slack` and
   `hydra-acp extensions logs hydra-acp-slack -f` to tail.

5. **Run standalone (alternative).** Set `HYDRA_DAEMON_URL` and
   `HYDRA_TOKEN` in `~/.hydra-acp-slack.conf` (or export them as env
   vars), then:

   ```sh
   npm start
   ```

   The daemon prints which hydra it's polling and which authorized users
   it accepts.

## Configuration keys

| Key                         | Default                            | Notes |
|-----------------------------|------------------------------------|-------|
| `SLACK_BOT_TOKEN`           | (required)                         | `xoxb-...` |
| `SLACK_APP_TOKEN`           | (required)                         | `xapp-...` |
| `SLACK_CHANNEL_ID`          | none                               | Default channel when per-project disabled or no mapping. |
| `AUTHORIZED_USERS`          | empty                              | Comma-separated Slack user IDs. Empty = inbound disabled. |
| `PER_PROJECT_CHANNELS`      | `true`                             | Look up channel per session cwd in the channel map. |
| `CHANNEL_PREFIX`            | empty                              | Reserved for auto-create flows; unused for now. |
| `CHANNELS_FILE`             | `~/.hydra-acp-slack/channels.json` | JSON map of cwd → channel ID. |
| `SHOW_TOOL_OUTPUT`          | `false`                            | If true, include tool body inline (still truncated). |
| `UPLOAD_TRANSCRIPT_ON_END`  | `true`                             | When the hydra session closes, upload the thread's contents as a markdown file attached to the same thread. Set to `false` to disable. |
| `HIDDEN_MESSAGES_DIR`       | `~/.hydra-acp-slack/hidden`        | Where 🙈-hidden message originals go. |
| `TRUNCATED_MESSAGES_DIR`    | `~/.hydra-acp-slack/truncated`     | Where full tool outputs cache for 📖 expand. |
| `TODO_DIRECTORY`            | `~/org/todo`                       | Where bookmark reactions write TODO files. |
| `WEBSOCKET_STALE_THRESHOLD` | `30`                               | Seconds of continuously-disconnected Slack Socket Mode WS before the bridge `process.exit(1)`s. Hydra's extension manager respawns it ~1s later with a fresh DNS cache + HTTP client; the existing process gets stuck in a reconnect loop after a network flap (VPN drop, etc.). |
| `BACKFILL_HISTORY`          | `false`                            | If true, replay hydra's cached history into Slack on attach. Off by default — replays trip Slack rate limits and create noise. |
| `LIVE_QUIET_MS`             | `2000`                             | Inbound silence (ms) needed before considering an attach "live" when `BACKFILL_HISTORY=false`. |
| `IMAGE_UPLOAD_RATE_LIMIT`   | `30`                               | Reserved. |
| `IMAGE_UPLOAD_RATE_WINDOW`  | `60`                               | Reserved. |
| `HYDRA_DAEMON_URL`          | `http://127.0.0.1:8765`            | Where to reach the hydra daemon. Set automatically when run as a hydra extension. |
| `HYDRA_WS_URL`              | derived from `HYDRA_DAEMON_URL`    | WebSocket endpoint for ACP attach. Defaults to `ws[s]://<host>:<port>/acp`. |
| `HYDRA_TOKEN`               | (required)                         | Bearer token for hydra. Set automatically when run as a hydra extension. |
| `HYDRA_POLL_INTERVAL_MS`    | `2000`                             | How often to poll hydra for session changes. |
| `DEBUG`                     | `false`                            | Verbose logging. |

## Reactions

| Reaction                                                                         | Action |
|----------------------------------------------------------------------------------|--------|
| `:white_check_mark:` / `:+1:` / `:star:`                                         | Approve once (picks the agent's `allow_once` option) |
| `:unlock:`                                                                       | Approve always (picks `allow_always` when offered, otherwise falls back to `allow_once`) |
| `:x:` / `:-1:`                                                                   | Deny |
| `:stop_sign:` / `:octagonal_sign:` / `:no_entry:` / `:no_entry_sign:` / `:stop:` | Cancel — react on the active turn spinner to send `session/cancel` to the agent. Ignored on any other message. |
| `:see_no_evil:` / `:no_bell:`                                                    | Hide message (toggle to restore) |
| `:eyes:`                                                                         | Expand truncated tool output |
| `:book:` / `:open_book:`                                                         | Expand full tool output |
| `:heart:` (and friends)                                                          | Forward as positive feedback to agent |
| `:bookmark:`                                                                     | Save message text as an org TODO |

## Slash-style commands

| Command                          | Where            | Effect |
|----------------------------------|------------------|--------|
| `!debug`                         | inside a thread  | Replies with the session's debug info (sessionId, channel, ws state, last-frame time). |
| `!agents`                        | anywhere         | Lists agents installed in hydra's registry (`GET /v1/agents`). |
| `!session [agent] [cwd] [prompt…]` | anywhere         | Asks hydra to create a fresh ACP session (`POST /v1/sessions`). Both positionals are optional — hydra falls back to `defaultAgent` and `defaultCwd` from `~/.hydra-acp/config.json` (which itself defaults to `claude-code` and `~`). |
| `!<rest>`                        | inside a thread  | Strict-mirror of slash commands: anything else starting with `!` is forwarded as `/<rest>` — e.g. `!hydra title foo` → `/hydra title foo`, `!hydra switch claude-code` → `/hydra switch claude-code`, `!create_plan write a function` → `/create_plan write a function`. The bot validates the verb against the daemon-advertised command set (`available_commands_update`, which the daemon merges its `/hydra` registry with the agent's own commands), so any new daemon or agent verb automatically becomes a `!`-command here. Unknown verbs get a `:grey_question:` reaction and a thread reply listing what's available. |

`!session` parsing rules:

- The first token, if path-like (`/…`, `~…`, `./…`), is the cwd; otherwise it's the agentId.
- The second token, only if the first was an agentId, may be the cwd.
- Anything remaining is the prompt sent as the session's first user message.
- A `--` separator forces everything after it to be the prompt — useful when the prompt itself starts with a word that would otherwise be parsed as the agent (e.g. `!session -- what time is it?`).

Examples:

```
!session                                  # default agent + default cwd, no first prompt
!session ~/dev/foo                        # default agent in ~/dev/foo
!session opencode                         # opencode in default cwd
!session opencode ~/dev/foo               # both
!session opencode ~/dev/foo fix the bug   # both + first prompt
!session ~/dev/foo fix the bug            # cwd + default agent + first prompt
!session -- what time is it?              # all defaults + first prompt
```

The bot reacts ✅ on the command message and replies with the resolved agent/cwd. The new thread appears in whichever channel the resolved cwd maps to (per `PER_PROJECT_CHANNELS` + `CHANNELS_FILE`), which may differ from where `!session` was posted.

## Tests

```
npm test
```

Runs the formatter, ndjson, reaction-map, and command-parser tests with
the built-in Node test runner.

## Out of scope

- Outbound image upload via file watcher.
- True ACP-to-ACP bridging (different project).

## Status

Functional, in daily use, but rough around the edges. Open issues at
the project repo.
