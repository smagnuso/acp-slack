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

  async deleteMessage(channel: string, ts: string): Promise<void> {
    try {
      const res = await this.app.client.chat.delete({ channel, ts });
      if (!res.ok) {
        log.warn(`chat.delete !ok: ${JSON.stringify(res)}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      // message_not_found is fine — already gone.
      if (!msg.includes("message_not_found")) {
        log.warn(`chat.delete threw: ${msg}`);
      }
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

  // Scan a channel for thread parents we previously opened for any of
  // Scan channel history for the thread parent that carries
  // `_session <sessionId>_` (see renderParent → sessionMarker). Lets a
  // daemon restart rediscover its session's existing thread without any
  // local disk state.
  //
  // Capped at ~1000 messages (10 pages of 100). A busier channel may
  // miss older threads — those will be reopened as new threads (worst
  // case is fragmentation, not loss).
  async findSessionThread(
    channel: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const marker = `_session ${sessionId}_`;
    let cursor: string | undefined;
    let scanned = 0;
    const cap = 1000;
    while (scanned < cap) {
      let res;
      try {
        res = await this.app.client.conversations.history({
          channel,
          cursor,
          limit: 100,
        });
      } catch (err) {
        log.warn(
          `findSessionThread: conversations.history(${channel}) failed: ${(err as Error).message}`,
        );
        return undefined;
      }
      const messages = res.messages ?? [];
      for (const m of messages) {
        if (typeof m.text !== "string") {
          continue;
        }
        if (m.text.includes(marker)) {
          const ts = m.thread_ts ?? m.ts;
          if (typeof ts === "string") {
            return ts;
          }
        }
      }
      scanned += messages.length;
      cursor = res.response_metadata?.next_cursor;
      if (!cursor) {
        return undefined;
      }
    }
    return undefined;
  }

  // Fetch every reply in a thread, paginating through Slack's
  // conversations.replies cursor. Used at session-end to build the
  // transcript-on-exit upload.
  async fetchAllReplies(
    channel: string,
    threadTs: string,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    while (true) {
      let res;
      try {
        res = await this.app.client.conversations.replies({
          channel,
          ts: threadTs,
          limit: 200,
          cursor,
        });
      } catch (err) {
        log.warn(
          `conversations.replies failed: ${(err as Error).message}`,
        );
        return out;
      }
      const messages = res.messages ?? [];
      for (const m of messages) {
        out.push(m as Record<string, unknown>);
      }
      cursor = res.response_metadata?.next_cursor;
      if (!cursor) {
        return out;
      }
    }
  }

  // Upload arbitrary text content as a file in a thread. Used for the
  // session-end transcript dump.
  async uploadFile(opts: {
    channel: string;
    threadTs: string | undefined;
    filename: string;
    title?: string;
    content: string;
  }): Promise<void> {
    try {
      const args: Record<string, unknown> = {
        channel_id: opts.channel,
        filename: opts.filename,
        content: opts.content,
      };
      if (opts.threadTs) {
        args.thread_ts = opts.threadTs;
      }
      if (opts.title) {
        args.title = opts.title;
      }
      // Slack's typed union for files.uploadV2 doesn't model thread_ts
      // as optional cleanly across its destination variants; the call
      // accepts the wire shape regardless.
      await this.app.client.files.uploadV2(
        // biome-ignore lint/suspicious/noExplicitAny: Slack types union
        args as any,
      );
    } catch (err) {
      log.warn(`files.uploadV2 failed: ${(err as Error).message}`);
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

// Stable, machine-greppable marker embedded in every thread-parent
// message we render. Contains the full sessionId (not the 8-char
// shortened display) so findSessionThread can find it again across
// daemon restarts. Italics keep it visually unobtrusive while staying
// in the message text (Slack metadata would also work, but text is
// scope-free and survives chat.update without ceremony).
export function sessionMarker(sessionId: string): string {
  return `_session ${sessionId}_`;
}
