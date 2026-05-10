import type { Config } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("commands");

export interface SessionArgs {
  agentId: string | undefined;
  cwd: string | undefined;
  prompt: string | undefined;
}

// Parse the body of a "!session ..." message.
//
// Positional grammar (before any "--"):
//   1. First token: if path-like (starts with /, ~, or ./), it's cwd;
//      else if word-shaped, it's agentId; else it's start-of-prompt.
//   2. Second token (only if first was agentId): if path-like, it's cwd;
//      else it's start-of-prompt.
//   3. Everything remaining is the prompt.
//
// Anything after "--" is unconditionally the prompt (use this when the
// prompt would otherwise be parsed as agentId, e.g. "!session -- what time").
//
// Examples:
//   !session                            → all defaults (hydra fills in)
//   !session ~/dev/foo                  → cwd=~/dev/foo
//   !session opencode                    → agentId=opencode
//   !session opencode ~/dev/foo         → both
//   !session opencode ~/dev/foo fix it  → both + prompt
//   !session ~/dev/foo fix it           → cwd + default agent + prompt
//   !session -- fix it                  → defaults + prompt
export function parseSessionArgs(body: string): SessionArgs {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { agentId: undefined, cwd: undefined, prompt: undefined };
  }
  const dashIdx = findStandaloneDoubleDash(trimmed);
  let positionalText: string;
  let promptText: string | undefined;
  if (dashIdx >= 0) {
    positionalText = trimmed.slice(0, dashIdx).trim();
    promptText = trimmed.slice(dashIdx + 2).trim();
    if (promptText.length === 0) {
      promptText = undefined;
    }
  } else {
    positionalText = trimmed;
    promptText = undefined;
  }
  const tokens = positionalText.length > 0 ? positionalText.split(/\s+/) : [];
  let agentId: string | undefined;
  let cwd: string | undefined;
  let i = 0;
  if (i < tokens.length) {
    const t = tokens[i]!;
    if (looksLikePath(t)) {
      cwd = t;
      i++;
    } else if (looksLikeAgentId(t)) {
      agentId = t;
      i++;
    }
  }
  if (agentId !== undefined && cwd === undefined && i < tokens.length) {
    const t = tokens[i]!;
    if (looksLikePath(t)) {
      cwd = t;
      i++;
    }
  }
  if (promptText === undefined && i < tokens.length) {
    promptText = tokens.slice(i).join(" ");
  }
  return { agentId, cwd, prompt: promptText };
}

function findStandaloneDoubleDash(s: string): number {
  const mid = s.indexOf(" -- ");
  if (mid >= 0) {
    return mid + 1;
  }
  if (s.startsWith("-- ") || s === "--") {
    return 0;
  }
  if (s.endsWith(" --")) {
    return s.length - 2;
  }
  return -1;
}

function looksLikePath(s: string): boolean {
  return s.startsWith("/") || s.startsWith("~") || s.startsWith("./");
}

function looksLikeAgentId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s);
}

export interface SessionResult {
  sessionId: string;
  agentId: string;
  cwd: string;
}

export async function createSession(
  config: Config,
  args: SessionArgs,
): Promise<SessionResult> {
  const body: Record<string, unknown> = {};
  if (args.agentId !== undefined) {
    body.agentId = args.agentId;
  }
  if (args.cwd !== undefined) {
    body.cwd = args.cwd;
  }
  const r = await fetch(`${config.hydraDaemonUrl}/v1/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.hydraToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`hydra POST /v1/sessions ${r.status}: ${text}`);
  }
  const result = (await r.json()) as SessionResult;
  log.info(
    `created session ${result.sessionId} agent=${result.agentId} cwd=${result.cwd}`,
  );
  return result;
}

export interface AgentEntry {
  id: string;
  name: string;
  version: string | undefined;
  description: string | undefined;
}

export async function listAgents(config: Config): Promise<AgentEntry[]> {
  const r = await fetch(`${config.hydraDaemonUrl}/v1/agents`, {
    headers: { Authorization: `Bearer ${config.hydraToken}` },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`hydra GET /v1/agents ${r.status}: ${text}`);
  }
  const result = (await r.json()) as { agents: AgentEntry[] };
  return result.agents ?? [];
}
