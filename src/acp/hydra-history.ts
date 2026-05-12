// Fetch the daemon's canonical history.jsonl for a session via the
// REST endpoint (`GET /v1/sessions/:id/history`) and render it as a
// markdown transcript suitable for upload to a Slack thread.
//
// The daemon is the authoritative source: every recordable session
// broadcast (prompts, agent text, tool calls, plans, turn boundaries)
// lands in history regardless of which client rendered it. Slack used
// to source the transcript from `conversations.replies` — i.e. what
// the channel rendered — which lost structure (no tool args / plan
// status / coalesced chunks). This module replaces that path.

export interface HydraHistoryEntry {
  method: string;
  params: unknown;
  recordedAt: number;
}

export async function fetchHydraHistory(opts: {
  daemonUrl: string;
  token: string;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<HydraHistoryEntry[]> {
  const url = `${opts.daemonUrl}/v1/sessions/${encodeURIComponent(opts.sessionId)}/history`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.token}` },
    signal: opts.signal,
  });
  if (!r.ok) {
    throw new Error(
      `hydra GET ${url} returned ${r.status} ${r.statusText}`,
    );
  }
  const text = await r.text();
  return parseHydraHistory(text);
}

export function parseHydraHistory(text: string): HydraHistoryEntry[] {
  const out: HydraHistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.method !== "string") {
      continue;
    }
    if (typeof obj.recordedAt !== "number") {
      continue;
    }
    out.push({
      method: obj.method,
      params: obj.params,
      recordedAt: obj.recordedAt,
    });
  }
  return out;
}

export interface RenderHydraHistoryOptions {
  sessionId: string;
  title?: string;
  cwd?: string;
  agentId?: string;
  currentModel?: string;
  currentMode?: string;
  entries: ReadonlyArray<HydraHistoryEntry>;
}

// Render an ordered list of hydra history entries as a markdown
// transcript. Coalesces successive agent_message_chunk entries into a
// single block, collapses tool_call / tool_call_update pairs into
// final per-tool status lines, and keeps only the last plan snapshot
// per turn (plans are emitted as a full snapshot on every change).
export function renderHydraHistoryAsMarkdown(
  opts: RenderHydraHistoryOptions,
): string {
  const blocks: string[] = [];

  type ToolState = { title: string; status: string };
  let agentBuf: { ts: number; text: string } | null = null;
  let thoughtBuf: { ts: number; text: string } | null = null;
  const tools = new Map<string, ToolState>();
  const toolOrder: string[] = [];
  let pendingPlan: ReadonlyArray<{ content: string; status?: string }> | null =
    null;

  const flushAgent = (): void => {
    if (agentBuf && agentBuf.text.length > 0) {
      blocks.push(`## Agent — ${isoTime(agentBuf.ts)}\n\n${agentBuf.text}`);
    }
    agentBuf = null;
  };
  const flushThought = (): void => {
    if (thoughtBuf && thoughtBuf.text.length > 0) {
      const indented = thoughtBuf.text
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      blocks.push(`### Thought — ${isoTime(thoughtBuf.ts)}\n\n${indented}`);
    }
    thoughtBuf = null;
  };
  const flushTools = (): void => {
    if (toolOrder.length === 0) {
      return;
    }
    const lines: string[] = ["### Tools", ""];
    for (const id of toolOrder) {
      const t = tools.get(id);
      if (!t) {
        continue;
      }
      lines.push(`- \`${t.title}\` — ${t.status}`);
    }
    blocks.push(lines.join("\n"));
    tools.clear();
    toolOrder.length = 0;
  };
  const flushPlan = (): void => {
    if (!pendingPlan || pendingPlan.length === 0) {
      pendingPlan = null;
      return;
    }
    const lines: string[] = ["### Plan", ""];
    for (const e of pendingPlan) {
      lines.push(`- ${planCheckbox(e.status)} ${e.content}`);
    }
    blocks.push(lines.join("\n"));
    pendingPlan = null;
  };

  for (const entry of opts.entries) {
    const params = entry.params as { update?: Record<string, unknown> } | null;
    const update = params?.update;
    if (!update) {
      continue;
    }
    const kind = update.sessionUpdate;
    if (typeof kind !== "string") {
      continue;
    }
    // Hydra emits a compat user_message_chunk alongside prompt_received
    // for clients that don't speak the newer event. Skip it; we use the
    // structured prompt_received instead.
    if (kind === "user_message_chunk") {
      const meta = update._meta as
        | { "hydra-acp"?: { compatFor?: string } }
        | undefined;
      if (meta?.["hydra-acp"]?.compatFor === "prompt_received") {
        continue;
      }
    }
    switch (kind) {
      case "prompt_received": {
        flushAgent();
        flushThought();
        flushTools();
        flushPlan();
        const text = extractPromptText(update.prompt);
        if (text) {
          blocks.push(`## User — ${isoTime(entry.recordedAt)}\n\n${text}`);
        }
        break;
      }
      case "user_message_chunk": {
        // Falls through here when there's no compatFor marker (a real
        // user_message_chunk from a peer client). Render as a User block.
        flushAgent();
        flushThought();
        const text = extractContentText(update.content);
        if (text) {
          blocks.push(`## User — ${isoTime(entry.recordedAt)}\n\n${text}`);
        }
        break;
      }
      case "agent_message_chunk": {
        flushThought();
        const text = extractContentText(update.content);
        if (text === null) {
          break;
        }
        if (agentBuf) {
          agentBuf.text += text;
        } else {
          agentBuf = { ts: entry.recordedAt, text };
        }
        break;
      }
      case "agent_thought_chunk":
      case "agent_thought": {
        flushAgent();
        const text =
          extractContentText(update.content) ??
          (typeof update.text === "string" ? update.text : null);
        if (text === null) {
          break;
        }
        if (thoughtBuf) {
          thoughtBuf.text += text;
        } else {
          thoughtBuf = { ts: entry.recordedAt, text };
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id =
          (typeof update.toolCallId === "string" && update.toolCallId) ||
          (typeof update.id === "string" && update.id) ||
          undefined;
        if (!id) {
          break;
        }
        const existing = tools.get(id);
        const title =
          (typeof update.title === "string" && update.title) ||
          existing?.title ||
          (typeof update.name === "string" && update.name) ||
          "tool";
        const status =
          (typeof update.status === "string" && update.status) ||
          existing?.status ||
          "pending";
        if (!existing) {
          toolOrder.push(id);
        }
        tools.set(id, { title, status });
        break;
      }
      case "plan": {
        if (Array.isArray(update.entries)) {
          const parsed: Array<{ content: string; status?: string }> = [];
          for (const raw of update.entries) {
            if (!raw || typeof raw !== "object") {
              continue;
            }
            const e = raw as Record<string, unknown>;
            if (typeof e.content !== "string") {
              continue;
            }
            parsed.push({
              content: e.content,
              status: typeof e.status === "string" ? e.status : undefined,
            });
          }
          pendingPlan = parsed;
        }
        break;
      }
      case "turn_complete": {
        flushAgent();
        flushThought();
        flushTools();
        flushPlan();
        const stopReason =
          typeof update.stopReason === "string" ? update.stopReason : undefined;
        if (stopReason && stopReason !== "end_turn") {
          blocks.push(`> _turn ended: ${stopReason}_`);
        }
        blocks.push("---");
        break;
      }
      case "error": {
        flushAgent();
        flushThought();
        const message =
          typeof update.message === "string" ? update.message : "error";
        blocks.push(`> ⚠ **error** — ${message}`);
        break;
      }
      default:
        // Snapshot-shaped kinds (session_info / model / mode / commands)
        // are filtered from history by the daemon, so we shouldn't see
        // them. Anything else is silently skipped to keep the transcript
        // focused on conversation content.
        break;
    }
  }
  flushAgent();
  flushThought();
  flushTools();
  flushPlan();

  const header: string[] = [];
  header.push(`# ${opts.title ?? "Session transcript"}`);
  header.push("");
  header.push(`- **Session:** \`${opts.sessionId}\``);
  if (opts.cwd) {
    header.push(`- **Cwd:** \`${opts.cwd}\``);
  }
  if (opts.agentId) {
    header.push(`- **Agent:** \`${opts.agentId}\``);
  }
  if (opts.currentModel) {
    header.push(`- **Model:** \`${opts.currentModel}\``);
  }
  if (opts.currentMode) {
    header.push(`- **Mode:** \`${opts.currentMode}\``);
  }
  header.push(`- **Exported:** ${new Date().toISOString()}`);
  header.push("");
  header.push("---");

  if (blocks.length === 0) {
    return `${header.join("\n")}\n\n_(no conversation content)_\n`;
  }
  return `${header.join("\n")}\n\n${blocks.join("\n\n")}\n`;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function planCheckbox(status: string | undefined): string {
  if (status === "completed") {
    return "[x]";
  }
  if (status === "in_progress") {
    return "[~]";
  }
  return "[ ]";
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!content || typeof content !== "object") {
    return null;
  }
  const c = content as { type?: unknown; text?: unknown };
  if (c.type === "text" && typeof c.text === "string") {
    return c.text;
  }
  if (typeof c.text === "string") {
    return c.text;
  }
  return null;
}

function extractPromptText(prompt: unknown): string | null {
  if (!Array.isArray(prompt)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of prompt) {
    const text = extractContentText(block);
    if (text !== null) {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join("");
}
