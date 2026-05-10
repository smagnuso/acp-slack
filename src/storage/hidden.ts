import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../util/log.js";

const log = logger("hidden");

// Hidden-message storage at <dir>/<channel>/<ts>.txt — used to restore a
// message's original text after the user removes the hide reaction.
export class HiddenStore {
  constructor(private readonly baseDir: string) {}

  save(channel: string, ts: string, text: string): void {
    const dir = join(this.baseDir, channel);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ts}.txt`), text);
    } catch (err) {
      log.warn(`save failed (${channel}/${ts}): ${(err as Error).message}`);
    }
  }

  load(channel: string, ts: string): string | undefined {
    try {
      return readFileSync(join(this.baseDir, channel, `${ts}.txt`), "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        log.warn(`load failed (${channel}/${ts}): ${e.message}`);
      }
      return undefined;
    }
  }

  remove(channel: string, ts: string): void {
    try {
      rmSync(join(this.baseDir, channel, `${ts}.txt`), { force: true });
    } catch (err) {
      log.warn(`remove failed (${channel}/${ts}): ${(err as Error).message}`);
    }
  }
}
