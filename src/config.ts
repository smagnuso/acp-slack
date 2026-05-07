import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string | undefined;
  authorizedUsers: Set<string>;
  perProjectChannels: boolean;
  channelPrefix: string;
  channelsFile: string;
  showToolOutput: boolean;
  uploadTranscriptOnEnd: boolean;
  hiddenMessagesDir: string;
  truncatedMessagesDir: string;
  todoDirectory: string;
  websocketStaleThreshold: number;
  imageUploadRateLimit: number;
  imageUploadRateWindow: number;
  socketDir: string;
  // When true, mirror the proxy's history replay to Slack on attach.
  // Default false — replaying long-running sessions floods the channel
  // and trips Slack's rate limits. Live activity from this point forward
  // works regardless.
  backfillHistory: boolean;
  // Quiet period (ms) of inbound silence before we consider the attach
  // "caught up to live." Used only when backfillHistory is false.
  liveQuietMs: number;
  debug: boolean;
}

const DEFAULT_CONF_PATH = resolve(homedir(), ".agent-shell-to-go.conf");

const TRUTHY = new Set(["1", "true", "yes", "on", "t"]);

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out.set(key, val);
  }
  return out;
}

function defaultSocketDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.length > 0 ? xdg : `/run/user/${process.getuid?.() ?? 1000}`;
  return resolve(base, "acp-multiplex");
}

function bool(map: Map<string, string>, key: string, fallback: boolean): boolean {
  const v = map.get(key);
  if (v === undefined) {
    return fallback;
  }
  return TRUTHY.has(v.toLowerCase());
}

function intVal(map: Map<string, string>, key: string, fallback: number): number {
  const v = map.get(key);
  if (v === undefined || v.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function stringSet(map: Map<string, string>, key: string): Set<string> {
  const v = map.get(key);
  if (!v) {
    return new Set();
  }
  return new Set(
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function loadConfig(path: string = DEFAULT_CONF_PATH): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read config at ${path}: ${(err as Error).message}. ` +
        `Set ACP_SLACK_CONF env var to override.`,
    );
  }
  const map = parseEnvFile(text);

  const slackBotToken = map.get("SLACK_BOT_TOKEN");
  const slackAppToken = map.get("SLACK_APP_TOKEN");
  if (!slackBotToken) {
    throw new Error(`SLACK_BOT_TOKEN missing in ${path}`);
  }
  if (!slackAppToken) {
    throw new Error(`SLACK_APP_TOKEN missing in ${path}`);
  }

  return {
    slackBotToken,
    slackAppToken,
    slackChannelId: map.get("SLACK_CHANNEL_ID") ?? undefined,
    authorizedUsers: stringSet(map, "AUTHORIZED_USERS"),
    perProjectChannels: bool(map, "PER_PROJECT_CHANNELS", true),
    channelPrefix: map.get("CHANNEL_PREFIX") ?? "",
    channelsFile: expandHome(
      map.get("CHANNELS_FILE") ?? "~/.agent-shell/slack-channels.json",
    ),
    showToolOutput: bool(map, "SHOW_TOOL_OUTPUT", false),
    uploadTranscriptOnEnd: bool(map, "UPLOAD_TRANSCRIPT_ON_END", true),
    hiddenMessagesDir: expandHome(
      map.get("HIDDEN_MESSAGES_DIR") ?? "~/.agent-shell/slack",
    ),
    truncatedMessagesDir: expandHome(
      map.get("TRUNCATED_MESSAGES_DIR") ?? "~/.agent-shell/slack-truncated",
    ),
    todoDirectory: expandHome(map.get("TODO_DIRECTORY") ?? "~/org/todo"),
    websocketStaleThreshold: intVal(map, "WEBSOCKET_STALE_THRESHOLD", 7200),
    imageUploadRateLimit: intVal(map, "IMAGE_UPLOAD_RATE_LIMIT", 30),
    imageUploadRateWindow: intVal(map, "IMAGE_UPLOAD_RATE_WINDOW", 60),
    socketDir: expandHome(map.get("ACP_SOCKET_DIR") ?? defaultSocketDir()),
    backfillHistory: bool(map, "BACKFILL_HISTORY", false),
    liveQuietMs: intVal(map, "LIVE_QUIET_MS", 2000),
    debug: bool(map, "DEBUG", false),
  };
}

export function configPath(): string {
  return process.env.ACP_SLACK_CONF ?? DEFAULT_CONF_PATH;
}
