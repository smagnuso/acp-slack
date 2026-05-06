import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config.js";
import { toSlackMrkdwn } from "../formatters/markdown.js";
import {
  type ToolCallStatus,
  renderToolCallHeader,
  statusIcon,
} from "../formatters/tool-call.js";
import type { ReactionAction } from "../slack/reaction-map.js";
import { threadRegistry } from "../slack/registry.js";
import { ChannelMap } from "../storage/channels.js";
import { HiddenStore } from "../storage/hidden.js";
import { TruncatedStore, fullExpand, truncate } from "../storage/truncated.js";
import type { ThreadClient } from "../slack/thread.js";
import { logger } from "../util/log.js";
import type { AcpAttach } from "./attach.js";
import type { JsonRpcNotification, JsonRpcRequest } from "./protocol.js";

const log = logger("session");

interface ToolCallState {
  toolCallId: string;
  threadMessageTs: string | undefined;
  status: ToolCallStatus | string | undefined;
  title: string | undefined;
  kind: string | undefined;
  bodyChunks: string[];
}

interface SessionState {
  sessionId: string;
  threadTs: string | undefined;
  channel: string;
  // Pending tool calls in flight, keyed by toolCallId.
  toolCalls: Map<string, ToolCallState>;
  // Streaming agent message: chunks accumulated until turn-complete or
  // the next message starts. We post a single Slack message at flush time.
  agentChunks: string[];
  agentMessageTs: string | undefined;
  // Last known title for chat.update of the thread header.
  title: string | undefined;
  // CWD of the session (used for per-project channel mapping).
  cwd: string | undefined;
}

export interface SessionBridgeOptions {
  attach: AcpAttach;
  config: Config;
  thread: ThreadClient;
  channels: ChannelMap;
  truncatedStore: TruncatedStore;
  hiddenStore: HiddenStore;
}

// One SessionBridge per acp-multiplex socket. Maintains per-session
// (sessionId) state — most sockets have a single session but the protocol
// allows multiple, so the bridge holds a map.
export class SessionBridge {
  private sessions = new Map<string, SessionState>();
  // sessionId -> resolver for any in-flight permission request awaiting a
  // Slack reaction. Phase 4 wires this up.
  permissionResolvers = new Map<
    string,
    {
      requestId: string | number;
      toolCallId: string;
      options: Array<{ optionId: string; name: string; kind?: string }>;
    }
  >();

  constructor(private readonly opts: SessionBridgeOptions) {
    opts.attach.on("notification", (n) => void this.onNotification(n));
    opts.attach.on("request", (r) => void this.onRequest(r));
  }

  // Public so the inbound handlers can route by sessionId.
  getSessionByThread(threadTs: string): SessionState | undefined {
    for (const s of this.sessions.values()) {
      if (s.threadTs === threadTs) {
        return s;
      }
    }
    return undefined;
  }

  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  private async onNotification(n: JsonRpcNotification): Promise<void> {
    const params = (n.params ?? {}) as Record<string, unknown>;
    const sessionId = (params.sessionId ?? params.session_id) as
      | string
      | undefined;
    log.debug(`notification ${n.method} sessionId=${sessionId ?? "(none)"}`);

    if (n.method === "session/update" && sessionId) {
      await this.handleSessionUpdate(sessionId, params);
      return;
    }

    if (n.method === "session/title-changed" && sessionId) {
      const title = params.title as string | undefined;
      if (title) {
        await this.applyTitle(sessionId, title);
      }
      return;
    }
  }

  private async onRequest(r: JsonRpcRequest): Promise<void> {
    const params = (r.params ?? {}) as Record<string, unknown>;
    const sessionId = params.sessionId as string | undefined;
    log.debug(`request ${r.method} sessionId=${sessionId ?? "(none)"}`);

    if (r.method === "session/request_permission" && sessionId) {
      await this.handlePermissionRequest(r, sessionId, params);
      return;
    }

    // For fs/* requests we deliberately don't pretend to be the editor —
    // primary frontend (agent-shell) already serves those. Reply with an
    // error so the agent falls back if it asks us.
    if (r.method.startsWith("fs/")) {
      this.opts.attach.replyError(
        r.id,
        -32601,
        "fs/* not supported by acp-slack secondary",
      );
      return;
    }
  }

  private async handleSessionUpdate(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const update = (params.update ?? {}) as Record<string, unknown>;
    const kind = update.sessionUpdate as string | undefined;
    const session = await this.ensureSession(sessionId, params);
    if (!session) {
      return;
    }

    switch (kind) {
      case "agent_message_chunk": {
        const content = (update.content ?? {}) as Record<string, unknown>;
        const text = (content.text ?? "") as string;
        if (text.length > 0) {
          session.agentChunks.push(text);
        }
        break;
      }
      case "user_message_chunk": {
        // Echo of what another frontend (or this bridge via Slack) typed.
        // We don't post these — they're already visible as the originating
        // Slack message.
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        await this.handleToolCallUpdate(session, update);
        break;
      }
      case "plan": {
        // Render agent plans/todos as a single message.
        const planText = renderPlan(update);
        if (planText) {
          await this.postOrAccumulate(session, "*Plan*\n" + planText);
        }
        break;
      }
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "usage_update":
        // Ignored — no slack-relevant signal.
        break;
      default:
        log.debug(`unhandled session/update kind=${kind ?? "?"}`);
    }
  }

  private async handlePermissionRequest(
    r: JsonRpcRequest,
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const session = await this.ensureSession(sessionId, params);
    if (!session) {
      // Can't surface the request; reject so agent doesn't hang.
      this.opts.attach.replyError(r.id, -32000, "no session bridge");
      return;
    }
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const toolCallId = (toolCall.toolCallId ?? "") as string;
    const options = (params.options ?? []) as Array<{
      optionId: string;
      name: string;
      kind?: string;
    }>;
    const title = (toolCall.title as string | undefined) ?? "Permission requested";

    this.permissionResolvers.set(sessionId, {
      requestId: r.id,
      toolCallId,
      options,
    });

    const optionLines = options
      .map(
        (o) =>
          `   • \`${o.optionId}\`  ${o.name}` + (o.kind ? `  _(${o.kind})_` : ""),
      )
      .join("\n");
    const text =
      `:lock: *Permission requested*\n${title}\n${optionLines}\n` +
      `_react :white_check_mark: to allow once, :x: to reject_`;
    await this.postOrAccumulate(session, text);
  }

  private async handleToolCallUpdate(
    session: SessionState,
    update: Record<string, unknown>,
  ): Promise<void> {
    const toolCallId = (update.toolCallId ?? "") as string;
    if (!toolCallId) {
      return;
    }
    let state = session.toolCalls.get(toolCallId);
    if (!state) {
      state = {
        toolCallId,
        threadMessageTs: undefined,
        status: undefined,
        title: undefined,
        kind: undefined,
        bodyChunks: [],
      };
      session.toolCalls.set(toolCallId, state);
    }
    if (typeof update.status === "string") {
      state.status = update.status;
    }
    if (typeof update.title === "string") {
      state.title = update.title;
    }
    if (typeof update.kind === "string") {
      state.kind = update.kind;
    }
    const content = update.content as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(content)) {
      for (const c of content) {
        const t = c.type as string | undefined;
        if (t === "content" || t === "diff" || t === undefined) {
          const inner = (c.content ?? c) as Record<string, unknown>;
          const text = inner.text as string | undefined;
          if (text) {
            state.bodyChunks.push(text);
          }
        }
      }
    }

    // Flush any pending agent message before switching to a tool-call card,
    // so order in the thread mirrors event order.
    await this.flushAgentMessage(session);

    const headerLine = renderToolCallHeader({
      status: state.status,
      title: state.title,
      kind: state.kind,
    });
    const body = state.bodyChunks.join("");
    const text = this.opts.config.showToolOutput && body
      ? `${headerLine}\n\`\`\`\n${truncate(body)}\n\`\`\``
      : headerLine;

    if (!state.threadMessageTs) {
      const r = await this.opts.thread.postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text,
      });
      state.threadMessageTs = r.ts;
      session.threadTs ??= r.threadTs;
      // Save full body for later 📖 expand.
      if (body) {
        this.opts.truncatedStore.save(
          session.channel,
          r.ts,
          body,
          headerLine,
        );
      }
    } else {
      await this.opts.thread.updateMessage(
        session.channel,
        state.threadMessageTs,
        text,
      );
      if (body) {
        this.opts.truncatedStore.save(
          session.channel,
          state.threadMessageTs,
          body,
          headerLine,
        );
      }
    }
  }

  private async ensureSession(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<SessionState | undefined> {
    let session = this.sessions.get(sessionId);
    if (session) {
      return session;
    }
    const cwd = this.cwdFromParams(params);
    const channel = this.resolveChannel(cwd);
    if (!channel) {
      log.warn(
        `no Slack channel resolved for sessionId=${sessionId} cwd=${cwd ?? "?"}; ` +
          `set SLACK_CHANNEL_ID or PER_PROJECT_CHANNELS=true with a known mapping`,
      );
      return undefined;
    }
    session = {
      sessionId,
      threadTs: undefined,
      channel,
      toolCalls: new Map(),
      agentChunks: [],
      agentMessageTs: undefined,
      title: undefined,
      cwd,
    };
    this.sessions.set(sessionId, session);
    // Open the thread with a header message we can update once we learn
    // the title.
    const initial = `:robot_face: *${cwd ? basename(cwd) : sessionId}*\n_session ${sessionId.slice(0, 8)}_`;
    const r = await this.opts.thread.postMessage({
      channel: session.channel,
      text: initial,
    });
    session.threadTs = r.threadTs;
    threadRegistry.register({
      bridge: this,
      sessionId,
      channel: session.channel,
      threadTs: session.threadTs,
    });
    log.info(
      `opened thread ${session.threadTs} in ${session.channel} for sessionId=${sessionId}`,
    );
    return session;
  }

  private cwdFromParams(params: Record<string, unknown>): string | undefined {
    if (typeof params.cwd === "string") {
      return params.cwd;
    }
    return undefined;
  }

  private resolveChannel(cwd: string | undefined): string | undefined {
    const cfg = this.opts.config;
    if (cfg.perProjectChannels && cwd) {
      const mapped = this.opts.channels.get(cwd);
      if (mapped) {
        return mapped;
      }
    }
    return cfg.slackChannelId ?? undefined;
  }

  private async applyTitle(sessionId: string, title: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.title === title) {
      return;
    }
    session.title = title;
    if (!session.threadTs) {
      return;
    }
    const cwd = session.cwd ? `\n_${session.cwd}_` : "";
    await this.opts.thread.updateMessage(
      session.channel,
      session.threadTs,
      `:robot_face: *${title}*${cwd}`,
    );
  }

  // Flush accumulated agent message chunks as a single Slack message and
  // start a new accumulation buffer.
  async flushAgentMessage(session: SessionState): Promise<void> {
    if (session.agentChunks.length === 0) {
      return;
    }
    const text = toSlackMrkdwn(session.agentChunks.join(""));
    session.agentChunks = [];
    if (!text.trim()) {
      return;
    }
    const r = await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text,
    });
    session.agentMessageTs = r.ts;
    session.threadTs ??= r.threadTs;
  }

  // Convenience: post text right now, flushing any pending agent message
  // first to preserve ordering.
  private async postOrAccumulate(
    session: SessionState,
    text: string,
  ): Promise<void> {
    await this.flushAgentMessage(session);
    const r = await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text,
    });
    session.threadTs ??= r.threadTs;
  }

  // Called by the entry point on a periodic timer to flush idle agent text.
  async flushAll(): Promise<void> {
    for (const s of this.sessions.values()) {
      await this.flushAgentMessage(s);
    }
  }

  // ---- Inbound (Slack -> agent) ----

  async sendUserPrompt(
    sessionId: string,
    text: string,
    images: ReadonlyArray<{ type: "image"; mimeType: string; data: string }> = [],
  ): Promise<void> {
    log.info(
      `prompt -> ${sessionId.slice(0, 8)}: ${text.slice(0, 80)}${images.length > 0 ? ` [+${images.length} image(s)]` : ""}`,
    );
    const prompt: Array<Record<string, unknown>> = [];
    if (text) {
      prompt.push({ type: "text", text });
    }
    for (const img of images) {
      prompt.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }
    await this.opts.attach.request("session/prompt", {
      sessionId,
      prompt,
    });
  }

  // Permission reaction → session/request_permission response.
  async respondToPermission(
    sessionId: string,
    optionId: string | "cancel",
  ): Promise<void> {
    const pending = this.permissionResolvers.get(sessionId);
    if (!pending) {
      log.debug(`no pending permission for ${sessionId}`);
      return;
    }
    this.permissionResolvers.delete(sessionId);
    if (optionId === "cancel") {
      this.opts.attach.reply(pending.requestId, {
        outcome: { outcome: "cancelled" },
      });
      return;
    }
    this.opts.attach.reply(pending.requestId, {
      outcome: { outcome: "selected", optionId },
    });
  }

  async handleReaction(
    sessionId: string,
    channel: string,
    ts: string,
    action: ReactionAction,
    added: boolean,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    switch (action) {
      case "allow":
      case "deny":
        if (!added) {
          return;
        }
        await this.handleAllowDeny(sessionId, action);
        return;
      case "hide":
        if (added) {
          await this.hideMessage(channel, ts);
        } else {
          await this.unhideMessage(channel, ts);
        }
        return;
      case "expand_truncated":
        if (added) {
          await this.expandTruncated(channel, ts);
        } else {
          await this.collapseExpanded(channel, ts);
        }
        return;
      case "expand_full":
        if (added) {
          await this.expandFull(channel, ts);
        } else {
          await this.collapseExpanded(channel, ts);
        }
        return;
      case "heart":
        if (added) {
          await this.handleHeart(channel, ts);
        }
        return;
      case "bookmark":
        if (added) {
          await this.handleBookmark(session, channel, ts);
        }
        return;
    }
  }

  private async handleAllowDeny(
    sessionId: string,
    action: "allow" | "deny",
  ): Promise<void> {
    const pending = this.permissionResolvers.get(sessionId);
    if (!pending) {
      return;
    }
    // Map allow/deny → first matching option id from the agent-supplied set.
    const wantKind: ReadonlyArray<string> =
      action === "allow"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
    const opt =
      pending.options.find((o) => o.kind && wantKind.includes(o.kind)) ??
      pending.options[0];
    const optionId = opt?.optionId;
    if (!optionId) {
      await this.respondToPermission(sessionId, "cancel");
      return;
    }
    await this.respondToPermission(sessionId, optionId);
  }

  private async hideMessage(channel: string, ts: string): Promise<void> {
    // Fetch current text, store it, replace with placeholder.
    const text = await this.fetchMessageText(channel, ts);
    if (text === undefined) {
      return;
    }
    this.opts.hiddenStore.save(channel, ts, text);
    await this.opts.thread.updateMessage(
      channel,
      ts,
      ":see_no_evil: _message hidden_",
    );
  }

  private async unhideMessage(channel: string, ts: string): Promise<void> {
    const original = this.opts.hiddenStore.load(channel, ts);
    if (original === undefined) {
      return;
    }
    await this.opts.thread.updateMessage(channel, ts, original);
    this.opts.hiddenStore.remove(channel, ts);
  }

  private async expandTruncated(channel: string, ts: string): Promise<void> {
    const full = this.opts.truncatedStore.loadFull(channel, ts);
    const collapsed = this.opts.truncatedStore.loadCollapsed(channel, ts);
    if (!full || !collapsed) {
      return;
    }
    const text = `${collapsed}\n\`\`\`\n${truncate(full)}\n\`\`\``;
    await this.opts.thread.updateMessage(channel, ts, text);
  }

  private async expandFull(channel: string, ts: string): Promise<void> {
    const full = this.opts.truncatedStore.loadFull(channel, ts);
    const collapsed = this.opts.truncatedStore.loadCollapsed(channel, ts);
    if (!full || !collapsed) {
      return;
    }
    const text = `${collapsed}\n\`\`\`\n${fullExpand(full)}\n\`\`\``;
    await this.opts.thread.updateMessage(channel, ts, text);
  }

  private async collapseExpanded(channel: string, ts: string): Promise<void> {
    const collapsed = this.opts.truncatedStore.loadCollapsed(channel, ts);
    if (!collapsed) {
      return;
    }
    await this.opts.thread.updateMessage(channel, ts, collapsed);
  }

  private async handleHeart(channel: string, ts: string): Promise<void> {
    // Forward as a user prompt so the agent sees positive feedback.
    const text = await this.fetchMessageText(channel, ts);
    if (text === undefined) {
      return;
    }
    // Pick any active session; for a multi-session bridge this is "the
    // current one" — we don't have a more specific signal here.
    const first = this.sessions.values().next().value;
    if (!first) {
      return;
    }
    await this.sendUserPrompt(
      first.sessionId,
      `The user heart-reacted to: ${text}`,
    );
  }

  private async handleBookmark(
    session: SessionState,
    channel: string,
    ts: string,
  ): Promise<void> {
    const text = await this.fetchMessageText(channel, ts);
    if (text === undefined) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(this.opts.config.todoDirectory, `bookmark-${stamp}.org`);
    try {
      mkdirSync(this.opts.config.todoDirectory, { recursive: true });
      writeFileSync(
        file,
        `* TODO ${session.title ?? session.sessionId}\n${text}\n`,
      );
    } catch (err) {
      log.warn(`bookmark write failed: ${(err as Error).message}`);
      return;
    }
    await this.opts.thread.postMessage({
      channel,
      threadTs: session.threadTs,
      text: `:bookmark: TODO created: \`${basename(file)}\``,
    });
  }

  private async fetchMessageText(
    channel: string,
    ts: string,
  ): Promise<string | undefined> {
    return this.opts.thread.fetchText(channel, ts);
  }

  debugInfo(sessionId: string): string {
    const s = this.sessions.get(sessionId);
    return JSON.stringify(
      {
        sessionId,
        threadTs: s?.threadTs,
        channel: s?.channel,
        cwd: s?.cwd,
        title: s?.title,
        socketPath: this.opts.attach.socketPath,
        connected: this.opts.attach.isConnected,
        lastFrameAt: new Date(this.opts.attach.lastFrameTime).toISOString(),
      },
      null,
      2,
    );
  }
}

function renderPlan(update: Record<string, unknown>): string | undefined {
  const entries = update.entries as
    | Array<{ content?: string; status?: string }>
    | undefined;
  if (!Array.isArray(entries)) {
    return undefined;
  }
  return entries
    .map((e) => {
      const icon = statusIcon(e.status as ToolCallStatus | undefined);
      return `${icon} ${e.content ?? ""}`;
    })
    .join("\n");
}

function statusIconShim(s: string | undefined): string {
  return statusIcon(s as ToolCallStatus | undefined);
}
// Keep the unused-import linter quiet but available for future use.
void statusIconShim;
