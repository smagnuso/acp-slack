import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../util/log.js";

const log = logger("truncated");

export const TRUNCATED_PREVIEW_LEN = 500;
// Slack's per-message hard cap is ~4 kB. Leave headroom for status emoji + label.
export const FULL_EXPAND_MAX = 3500;

// Tool-output text is saved to disk on emit so the user can later expand
// (👀 → first ~500 chars, 📖 → up to ~4 kB).
//   <dir>/<channel>/<ts>.txt           full text
//   <dir>/<channel>/<ts>.txt.collapsed original collapsed-state body (status icon)
export class TruncatedStore {
  constructor(private readonly baseDir: string) {}

  save(channel: string, ts: string, fullText: string, collapsed: string): void {
    const dir = join(this.baseDir, channel);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ts}.txt`), fullText);
      writeFileSync(join(dir, `${ts}.txt.collapsed`), collapsed);
    } catch (err) {
      log.warn(`save failed (${channel}/${ts}): ${(err as Error).message}`);
    }
  }

  loadFull(channel: string, ts: string): string | undefined {
    return this.read(join(this.baseDir, channel, `${ts}.txt`));
  }

  loadCollapsed(channel: string, ts: string): string | undefined {
    return this.read(join(this.baseDir, channel, `${ts}.txt.collapsed`));
  }

  remove(channel: string, ts: string): void {
    for (const suffix of [".txt", ".txt.collapsed"]) {
      try {
        rmSync(join(this.baseDir, channel, `${ts}${suffix}`), { force: true });
      } catch {
        // Ignore.
      }
    }
  }

  private read(p: string): string | undefined {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        log.warn(`load failed (${p}): ${e.message}`);
      }
      return undefined;
    }
  }
}

export function truncate(text: string, max = TRUNCATED_PREVIEW_LEN): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n… 📖 _for full output_`;
}

export function fullExpand(text: string, max = FULL_EXPAND_MAX): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n… _truncated at ${max} chars_`;
}
