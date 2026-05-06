import type { App } from "@slack/bolt";
import { logger } from "../util/log.js";

const log = logger("slack-thread");

export interface PostOpts {
  channel: string;
  threadTs?: string;
  text: string;
  // If set, opens a thread when not provided.
  unfurl?: boolean;
}

export interface PostResult {
  channel: string;
  ts: string;
  threadTs: string;
}

export class ThreadClient {
  constructor(private readonly app: App) {}

  async postMessage(opts: PostOpts): Promise<PostResult> {
    const res = await this.app.client.chat.postMessage({
      channel: opts.channel,
      text: opts.text,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      unfurl_links: opts.unfurl ?? false,
      unfurl_media: opts.unfurl ?? false,
    });
    if (!res.ok || !res.ts || !res.channel) {
      throw new Error(`postMessage failed: ${JSON.stringify(res)}`);
    }
    return {
      channel: res.channel,
      ts: res.ts,
      threadTs: opts.threadTs ?? res.ts,
    };
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    try {
      const res = await this.app.client.chat.update({ channel, ts, text });
      if (!res.ok) {
        log.warn(`chat.update !ok: ${JSON.stringify(res)}`);
      }
    } catch (err) {
      log.warn(`chat.update threw: ${(err as Error).message}`);
    }
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.app.client.reactions.add({ channel, timestamp: ts, name });
    } catch (err) {
      const msg = (err as Error).message;
      // already_reacted is fine.
      if (!msg.includes("already_reacted")) {
        log.warn(`reactions.add(${name}) failed: ${msg}`);
      }
    }
  }

  async fetchText(channel: string, ts: string): Promise<string | undefined> {
    try {
      const res = await this.app.client.conversations.replies({
        channel,
        ts,
        limit: 1,
        inclusive: true,
      });
      return res.messages?.[0]?.text;
    } catch (err) {
      log.warn(`conversations.replies failed: ${(err as Error).message}`);
      return undefined;
    }
  }
}
