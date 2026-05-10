import { logger } from "./util/log.js";

const log = logger("discovery");

export interface HydraSessionInfo {
  sessionId: string;
  cwd: string;
  agentId: string | undefined;
  title: string | undefined;
  attachedClients: number;
  updatedAt: string;
  status: "live" | "cold";
}

export interface HydraDiscoveryOptions {
  daemonUrl: string;
  token: string;
  pollIntervalMs?: number;
  onAdd: (session: HydraSessionInfo) => void;
  onRemove: (sessionId: string) => void;
}

const DEFAULT_POLL_MS = 2_000;

export class HydraDiscovery {
  private timer: NodeJS.Timeout | undefined;
  private known = new Map<string, HydraSessionInfo>();
  private stopped = false;
  private inFlight = false;

  constructor(private readonly opts: HydraDiscoveryOptions) {}

  start(): void {
    log.info(
      `polling ${this.opts.daemonUrl}/v1/sessions every ${this.opts.pollIntervalMs ?? DEFAULT_POLL_MS}ms`,
    );
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.opts.pollIntervalMs ?? DEFAULT_POLL_MS);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const r = await fetch(`${this.opts.daemonUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${this.opts.token}` },
      });
      if (!r.ok) {
        log.warn(`daemon /v1/sessions returned ${r.status}`);
        return;
      }
      const body = (await r.json()) as { sessions: HydraSessionInfo[] };
      const seen = new Map<string, HydraSessionInfo>();
      for (const s of body.sessions) {
        if (s.status !== "live") {
          continue;
        }
        seen.set(s.sessionId, s);
      }
      for (const [id, s] of seen) {
        if (!this.known.has(id)) {
          this.known.set(id, s);
          try {
            this.opts.onAdd(s);
          } catch (err) {
            log.warn(`onAdd error for ${id}: ${(err as Error).message}`);
          }
        } else {
          this.known.set(id, s);
        }
      }
      for (const id of [...this.known.keys()]) {
        if (!seen.has(id)) {
          this.known.delete(id);
          try {
            this.opts.onRemove(id);
          } catch (err) {
            log.warn(`onRemove error for ${id}: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      log.debug(`poll error: ${(err as Error).message}`);
    } finally {
      this.inFlight = false;
    }
  }

  current(): HydraSessionInfo[] {
    return [...this.known.values()];
  }
}
