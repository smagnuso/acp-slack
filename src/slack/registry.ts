import type { SessionBridge } from "../acp/session.js";

// Slack handlers receive (channel, threadTs) but need a SessionBridge +
// sessionId to act. SessionBridges register threads here when they open
// them; handlers look them up.
//
// Multi-entry: when several proxies are running against the same Claude
// Code session DB (each acp-multiplex spawns its own agent process,
// but session/list returns the same global session set), more than one
// bridge ends up claiming the same (channel, threadTs) on attach. The
// session is only actually live in *one* of those agent processes; the
// others would return -32603 Internal error if asked to handle a prompt
// for it. We keep all candidates and prefer the one that has shown
// agent-side activity for the session (promoted via promote()), with
// app.ts's message handler falling back to others if the first fails.
export interface ThreadEntry {
  bridge: SessionBridge;
  sessionId: string;
  channel: string;
  threadTs: string;
}

class ThreadRegistry {
  private byThread = new Map<string, ThreadEntry[]>(); // key: channel|threadTs

  register(entry: ThreadEntry): void {
    const k = this.key(entry.channel, entry.threadTs);
    const list = this.byThread.get(k) ?? [];
    if (list.some((e) => e.bridge === entry.bridge)) {
      return; // already registered for this bridge
    }
    list.push(entry);
    this.byThread.set(k, list);
  }

  unregisterBridge(bridge: SessionBridge): void {
    for (const [k, list] of this.byThread) {
      const filtered = list.filter((e) => e.bridge !== bridge);
      if (filtered.length === 0) {
        this.byThread.delete(k);
      } else if (filtered.length !== list.length) {
        this.byThread.set(k, filtered);
      }
    }
  }

  // Backwards-compatible single-entry lookup. Returns the highest-
  // priority candidate (front of the list). Reaction handlers and
  // callers that only need *some* bridge for a thread (e.g. fetching
  // text) use this.
  lookup(channel: string, threadTs: string): ThreadEntry | undefined {
    return this.byThread.get(this.key(channel, threadTs))?.[0];
  }

  // All candidate bridges for a thread, in priority order. Inbound
  // message routing iterates this and falls back on send error.
  lookupAll(channel: string, threadTs: string): ThreadEntry[] {
    return [...(this.byThread.get(this.key(channel, threadTs)) ?? [])];
  }

  // Move the entry for `bridge` on this thread to the front of the
  // candidate list. Called when a bridge proves it owns the session
  // (either by emitting a session/update notification for it, or by
  // successfully servicing an inbound prompt). No-op if `bridge` isn't
  // a candidate, already at the front, or the thread has only one
  // candidate.
  promote(bridge: SessionBridge, channel: string, threadTs: string): void {
    const k = this.key(channel, threadTs);
    const list = this.byThread.get(k);
    if (!list || list.length < 2) {
      return;
    }
    const idx = list.findIndex((e) => e.bridge === bridge);
    if (idx <= 0) {
      return;
    }
    const moved = list.splice(idx, 1);
    if (moved[0]) {
      list.unshift(moved[0]);
    }
  }

  private key(channel: string, threadTs: string): string {
    return `${channel}|${threadTs}`;
  }
}

export const threadRegistry = new ThreadRegistry();
