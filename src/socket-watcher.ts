import { FSWatcher, watch } from "chokidar";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { logger } from "./util/log.js";

const log = logger("watcher");

export interface SocketWatcherOptions {
  dir: string;
  onAdd: (socketPath: string) => void;
  onRemove: (socketPath: string) => void;
}

// Watches dir for *.sock files. Filters out non-sockets and dead sockets
// (acp-multiplex names them <pid>.sock; if the pid is gone, skip it).
export class SocketWatcher {
  private watcher: FSWatcher | undefined;
  private active = new Set<string>();

  constructor(private readonly opts: SocketWatcherOptions) {}

  start(): void {
    if (!existsSync(this.opts.dir)) {
      log.warn(`socket dir does not exist yet: ${this.opts.dir}`);
    }
    log.info(`watching ${this.opts.dir}`);
    this.watcher = watch(this.opts.dir, {
      depth: 0,
      persistent: true,
      ignoreInitial: false,
    });

    this.watcher.on("add", (p: string) => this.maybeAdd(p));
    this.watcher.on("unlink", (p: string) => this.maybeRemove(p));
    this.watcher.on("error", (err: unknown) => {
      log.warn(`watcher error: ${(err as Error).message}`);
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }

  private maybeAdd(p: string): void {
    if (extname(p) !== ".sock") {
      return;
    }
    if (!this.isLiveSocket(p)) {
      log.debug(`skip dead socket ${p}`);
      return;
    }
    if (this.active.has(p)) {
      return;
    }
    this.active.add(p);
    this.opts.onAdd(p);
  }

  private maybeRemove(p: string): void {
    if (extname(p) !== ".sock") {
      return;
    }
    if (!this.active.has(p)) {
      return;
    }
    this.active.delete(p);
    this.opts.onRemove(p);
  }

  // acp-multiplex names sockets <pid>.sock. If the pid is gone, the proxy
  // is dead and the socket is stale.
  private isLiveSocket(p: string): boolean {
    const m = p.match(/(\d+)\.sock$/);
    if (!m || !m[1]) {
      // Not a pid-named socket; trust the watcher.
      return true;
    }
    const pid = Number.parseInt(m[1], 10);
    if (!Number.isFinite(pid)) {
      return true;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // EPERM = process exists but we can't signal it; still alive enough.
      if (e.code === "EPERM") {
        return true;
      }
      return false;
    }
  }
}
