import bolt from "@slack/bolt";
import type { Config } from "../config.js";
import { logger } from "../util/log.js";
import { reactionAction } from "./reaction-map.js";
import { threadRegistry } from "./registry.js";

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
    if (!m.thread_ts || !m.channel || !m.user) {
      log.info(
        `drop: missing fields thread_ts=${m.thread_ts ?? "(none)"} channel=${m.channel ?? "(none)"} user=${m.user ?? "(none)"}`,
      );
      return;
    }
    if (config.authorizedUsers.size > 0 && !config.authorizedUsers.has(m.user)) {
      log.info(`drop: unauthorized user ${m.user}`);
      return;
    }
    const entry = threadRegistry.lookup(m.channel, m.thread_ts);
    if (!entry) {
      log.info(
        `drop: no bridge for thread channel=${m.channel} thread_ts=${m.thread_ts}`,
      );
      return;
    }
    const text = (m.text ?? "").trim();
    if (!text && !(m.files && m.files.length > 0)) {
      return;
    }
    if (text.startsWith("!debug")) {
      const info = entry.bridge.debugInfo(entry.sessionId);
      await app.client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.thread_ts,
        text: "```\n" + info + "\n```",
      });
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
    try {
      await entry.bridge.sendUserPrompt(entry.sessionId, text, imageBlocks);
    } catch (err) {
      log.warn(`session/prompt failed: ${(err as Error).message}`);
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
    // Reactions can target either the thread parent (root ts) or any
    // message inside the thread. Look up by both forms.
    const entry =
      threadRegistry.lookup(channel, ts) ??
      (await tryLookupByMessage(app, channel, ts));
    if (!entry) {
      return;
    }
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
