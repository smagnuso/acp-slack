import type { SessionBridge } from "../acp/session.js";

// Slack handlers receive (channel, threadTs) but need a SessionBridge +
// sessionId to act. SessionBridges register threads here when they open
// them; handlers look them up.
export interface ThreadEntry {
  bridge: SessionBridge;
  sessionId: string;
  channel: string;
  threadTs: string;
}

class ThreadRegistry {
  private byThread = new Map<string, ThreadEntry>(); // key: channel|threadTs

  register(entry: ThreadEntry): void {
    this.byThread.set(this.key(entry.channel, entry.threadTs), entry);
  }

  unregisterBridge(bridge: SessionBridge): void {
    for (const [k, v] of this.byThread) {
      if (v.bridge === bridge) {
        this.byThread.delete(k);
      }
    }
  }

  lookup(channel: string, threadTs: string): ThreadEntry | undefined {
    return this.byThread.get(this.key(channel, threadTs));
  }

  private key(channel: string, threadTs: string): string {
    return `${channel}|${threadTs}`;
  }
}

export const threadRegistry = new ThreadRegistry();
