import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../util/log.js";

const log = logger("channels");

// JSON file mapping absolute project path -> Slack channel ID.
// Example: { "/home/me/code/foo": "C123ABC", ... }
export class ChannelMap {
  private map = new Map<string, string>();
  private loaded = false;

  constructor(private readonly path: string) {}

  load(): void {
    if (this.loaded) {
      return;
    }
    try {
      const text = readFileSync(this.path, "utf8");
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string") {
            this.map.set(k, v);
          }
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        log.warn(`failed to load ${this.path}: ${e.message}`);
      }
    }
    this.loaded = true;
  }

  get(projectPath: string): string | undefined {
    this.load();
    return this.map.get(projectPath);
  }

  set(projectPath: string, channelId: string): void {
    this.load();
    this.map.set(projectPath, channelId);
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const obj: Record<string, string> = {};
      for (const [k, v] of this.map) {
        obj[k] = v;
      }
      writeFileSync(this.path, JSON.stringify(obj, null, 2));
    } catch (err) {
      log.warn(`failed to save ${this.path}: ${(err as Error).message}`);
    }
  }
}
