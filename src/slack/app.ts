import bolt from "@slack/bolt";
import type { Config } from "../config.js";
import { logger } from "../util/log.js";
import { listAgents, parseSpawnArgs, spawnSession } from "./commands.js";
import { reactionAction } from "./reaction-map.js";
import { threadRegistry } from "./registry.js";
import {
  attemptResurrect,
  bufferPendingMessage,
  findSessionIdForThread,
} from "./resurrect.js";

const log = logger("slack");

export interface SlackApp {
  app: bolt.App;
  client: bolt.App["client"];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSlackApp(config: Config): SlackApp {
  const app = new bolt.App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: config.debug ? bolt.LogLevel.DEBUG : bolt.LogLevel.INFO,
  });

  app.error(async (err) => {
    log.error("bolt error", err);
  });

  // Inbound message → ACP session/prompt.
  app.message(async ({ message }) => {
    const m = message as Partial<{
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      channel?: string;
      files?: Array<{
        id: string;
        mimetype?: string;
        url_private?: string;
        url_private_download?: string;
      }>;
    }>;
    const preview = (m.text ?? "").slice(0, 60);
    log.info(
      `inbound msg user=${m.user ?? "?"} channel=${m.channel ?? "?"} thread=${m.thread_ts ?? "(none)"} subtype=${m.subtype ?? "(none)"} bot=${m.bot_id ?? "(none)"} ts=${m.ts ?? "?"} text="${preview}"`,
    );
    if ((m.subtype && m.subtype !== "file_share") || m.bot_id) {
      log.info(
        `drop: subtype=${m.subtype ?? "(none)"} bot=${m.bot_id ?? "(none)"}`,
      );
      return;
    }
    if (!m.channel || !m.user || !m.ts) {
      log.info(
        `drop: missing fields channel=${m.channel ?? "(none)"} user=${m.user ?? "(none)"} ts=${m.ts ?? "(none)"}`,
      );
      return;
    }
    if (config.authorizedUsers.size > 0 && !config.authorizedUsers.has(m.user)) {
      log.info(`drop: unauthorized user ${m.user}`);
      return;
    }
    const rawText = (m.text ?? "").trim();
    if (rawText.startsWith("!spawn")) {
      await handleSpawn(app, config, rawText, m.channel, m.ts);
      return;
    }
    if (rawText === "!agents") {
      await handleAgents(app, config, m.channel, m.ts);
      return;
    }
    if (!m.thread_ts) {
      log.info(`drop: top-level message without bang-command`);
      return;
    }
    const candidates = threadRegistry.lookupAll(m.channel, m.thread_ts);
    const text = (m.text ?? "").trim();
    if (!text && !(m.files && m.files.length > 0)) {
      return;
    }
    // Download any attached images and forward as multimodal content.
    const imageBlocks: Array<{ type: "image"; mimeType: string; data: string }> =
      [];
    for (const f of m.files ?? []) {
      if (!f.mimetype || !f.mimetype.startsWith("image/")) {
        continue;
      }
      const url = f.url_private_download ?? f.url_private;
      if (!url) {
        continue;
      }
      try {
        const data = await downloadAsBase64(url, config.slackBotToken);
        imageBlocks.push({ type: "image", mimeType: f.mimetype, data });
      } catch (err) {
        log.warn(`image download failed: ${(err as Error).message}`);
      }
    }
    if (candidates.length === 0) {
      // Thread has no live bridge — likely a cold session whose disk
      // record outlived its agent process. Try to resurrect via a
      // transient session/attach (hydra revives from loadFromDisk),
      // and buffer the user's message so the new bridge picks it up
      // when discovery's next poll catches the now-live session.
      const sessionId = await findSessionIdForThread(
        app,
        m.channel,
        m.thread_ts,
      );
      if (!sessionId) {
        log.info(
          `drop: no bridge or session marker for thread channel=${m.channel} thread_ts=${m.thread_ts}`,
        );
        return;
      }
      bufferPendingMessage(sessionId, { text, images: imageBlocks });
      log.info(
        `cold thread ${m.thread_ts} → buffer + resurrect ${sessionId.slice(0, 8)}`,
      );
      attemptResurrect(config, sessionId).catch((err: unknown) => {
        log.warn(
          `resurrect ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`,
        );
      });
      return;
    }
    // First candidate is the preferred one (most recent live activity);
    // fall back to others if the prompt fails (e.g. when multiple
    // proxies share the Claude Code session DB but only one has the
    // session in memory). The succeeding candidate gets promoted in
    // the registry below so future routes prefer it.
    const entry = candidates[0]!;
    if (text.startsWith("!debug")) {
      const info = entry.bridge.debugInfo(entry.sessionId);
      await app.client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: "```\n" + info + "\n```",
      });
      return;
    }
    let routed = false;
    let lastError: string | undefined;
    for (const candidate of candidates) {
      try {
        await candidate.bridge.sendUserPrompt(
          candidate.sessionId,
          text,
          imageBlocks,
        );
        threadRegistry.promote(candidate.bridge, m.channel, m.thread_ts);
        routed = true;
        break;
      } catch (err) {
        lastError = (err as Error).message;
        if (candidates.length > 1) {
          log.info(
            `route attempt failed (${lastError}); trying next of ${candidates.length} candidate(s)`,
          );
        }
      }
    }
    if (!routed) {
      log.warn(
        `session/prompt failed across ${candidates.length} bridge(s): ${lastError ?? "?"}`,
      );
      await app.client.reactions
        .add({ channel: m.channel, timestamp: m.ts ?? "", name: "warning" })
        .catch(() => undefined);
    }
  });

  // Reaction added → permission, hide, expand, etc.
  app.event("reaction_added", async ({ event }) => {
    const e = event as {
      user: string;
      reaction: string;
      item: { channel?: string; ts?: string };
    };
    if (config.authorizedUsers.size > 0 && !config.authorizedUsers.has(e.user)) {
      log.info(`reaction drop: unauthorized user ${e.user} :${e.reaction}:`);
      return;
    }
    const channel = e.item.channel;
    const ts = e.item.ts;
    if (!channel || !ts) {
      log.info(
        `reaction drop: missing channel/ts :${e.reaction}: channel=${channel ?? "(none)"} ts=${ts ?? "(none)"}`,
      );
      return;
    }
    const action = reactionAction(e.reaction);
    if (!action) {
      // Only log when the reaction landed on a thread we own — avoids
      // logging every random reaction on unrelated channel messages.
      const entry =
        threadRegistry.lookup(channel, ts) ??
        (await tryLookupByMessage(app, channel, ts));
      if (entry) {
        log.info(`unmapped reaction :${e.reaction}: on ${channel}/${ts}`);
      }
      return;
    }
    // Reactions can target either the thread parent (root ts) or any
    // message inside the thread. Look up by both forms.
    const directEntry = threadRegistry.lookup(channel, ts);
    const entry = directEntry ?? (await tryLookupByMessage(app, channel, ts));
    if (!entry) {
      log.info(
        `reaction drop: no bridge for ${channel}/${ts} (direct=${!!directEntry}) :${e.reaction}:→${action}`,
      );
      return;
    }
    log.info(
      `reaction route: :${e.reaction}:→${action} ${channel}/${ts} session=${entry.sessionId.slice(0, 8)} (direct=${!!directEntry})`,
    );
    try {
      await entry.bridge.handleReaction(entry.sessionId, channel, ts, action, true);
    } catch (err) {
      log.warn(`reaction(${e.reaction}) failed: ${(err as Error).message}`);
    }
  });

  app.event("reaction_removed", async ({ event }) => {
    const e = event as {
      user: string;
      reaction: string;
      item: { channel?: string; ts?: string };
    };
    if (config.authorizedUsers.size > 0 && !config.authorizedUsers.has(e.user)) {
      return;
    }
    const channel = e.item.channel;
    const ts = e.item.ts;
    if (!channel || !ts) {
      return;
    }
    const action = reactionAction(e.reaction);
    if (!action) {
      return;
    }
    const entry =
      threadRegistry.lookup(channel, ts) ??
      (await tryLookupByMessage(app, channel, ts));
    if (!entry) {
      return;
    }
    try {
      await entry.bridge.handleReaction(entry.sessionId, channel, ts, action, false);
    } catch (err) {
      log.warn(`reaction(${e.reaction}) remove failed: ${(err as Error).message}`);
    }
  });

  return {
    app,
    client: app.client,
    async start() {
      await app.start();
      log.info("Slack Socket Mode connected");
    },
    async stop() {
      await app.stop();
      log.info("Slack stopped");
    },
  };
}

async function downloadAsBase64(url: string, botToken: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

// When the reaction's target is a message inside a thread (not the parent),
// we need the parent's ts to look up the bridge. Fetch the message and use
// its thread_ts.
async function tryLookupByMessage(
  app: bolt.App,
  channel: string,
  ts: string,
): Promise<ReturnType<typeof threadRegistry.lookup>> {
  try {
    const res = await app.client.conversations.replies({
      channel,
      ts,
      limit: 1,
      inclusive: true,
    });
    const msg = res.messages?.[0];
    const threadTs = msg?.thread_ts ?? msg?.ts;
    if (!threadTs) {
      return undefined;
    }
    return threadRegistry.lookup(channel, threadTs);
  } catch {
    return undefined;
  }
}

async function handleSpawn(
  app: bolt.App,
  config: Config,
  rawText: string,
  channel: string,
  ts: string,
): Promise<void> {
  const body = rawText.slice("!spawn".length);
  const args = parseSpawnArgs(body);
  let result;
  try {
    result = await spawnSession(config, args);
  } catch (err) {
    log.warn(`spawn failed: ${(err as Error).message}`);
    await app.client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `:warning: spawn failed: ${(err as Error).message}`,
    });
    return;
  }
  if (args.prompt) {
    bufferPendingMessage(result.sessionId, {
      text: args.prompt,
      images: [],
    });
  }
  await app.client.reactions
    .add({ channel, timestamp: ts, name: "white_check_mark" })
    .catch(() => undefined);
  const shortId = result.sessionId.slice(0, 8);
  await app.client.chat.postMessage({
    channel,
    thread_ts: ts,
    text:
      `:rocket: spawning \`${result.agentId}\` in \`${result.cwd}\` ` +
      `(session \`${shortId}\`); thread will appear once the agent is ready` +
      (args.prompt ? "; first prompt queued" : ""),
  });
}

async function handleAgents(
  app: bolt.App,
  config: Config,
  channel: string,
  ts: string,
): Promise<void> {
  let agents;
  try {
    agents = await listAgents(config);
  } catch (err) {
    log.warn(`!agents failed: ${(err as Error).message}`);
    await app.client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `:warning: agents lookup failed: ${(err as Error).message}`,
    });
    return;
  }
  if (agents.length === 0) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: ":information_source: no agents installed in hydra registry",
    });
    return;
  }
  const lines = agents.map((a) => {
    const ver = a.version ? ` v${a.version}` : "";
    const desc = a.description ? ` — ${a.description}` : "";
    return `• \`${a.id}\`${ver}${desc}`;
  });
  await app.client.chat.postMessage({
    channel,
    thread_ts: ts,
    text: ["*Available agents:*", ...lines].join("\n"),
  });
}
