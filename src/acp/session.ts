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
import { sessionMarker, type ThreadClient } from "../slack/thread.js";
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
  // Streaming agent message. Chunks accumulate for the lifetime of one
  // agent message; flushAgentMessage posts on the first flush and updates
  // the same Slack message on subsequent flushes, so one agent burst
  // shows up as one live-streaming Slack message rather than fragmenting
  // each time the periodic flush fires. closeAgentMessage clears these
  // (called on turn_complete, before tool cards, before sibling user
  // messages, etc.) so the next stream begins a fresh Slack message.
  agentChunks: string[];
  agentMessageTs: string | undefined;
  // Last text written to Slack for the currently-open agent message; used
  // to skip no-op updates when a flush fires with no new chunks.
  agentLastSent: string | undefined;
  // Per-session flush serializer. Concurrent calls (periodic timer +
  // turn_complete arm + user_message_chunk arm + own-turn end after
  // session/prompt) would otherwise race on agentMessageTs — both seeing
  // it undefined, both calling postMessage, producing two Slack messages
  // for one agent burst. Each flush queues onto this chain so the
  // post-and-set-ts step is effectively atomic.
  agentFlushChain: Promise<void> | undefined;
  // Per-session inbound-prompt serializer. Bolt runs app.message handlers
  // in parallel; without this, three Slack messages typed in quick
  // succession produce three concurrent session/prompt requests, the
  // proxy synthesizes user_message_chunks for all of them back-to-back,
  // and sibling frontends (agent-shell) merge them into a single rendered
  // prompt because no agent activity falls between them. Queueing forces
  // turn-by-turn flow: each prompt awaits the previous one's response
  // (and our own-turn-end close) before sending.
  promptChain: Promise<void> | undefined;
  // Streaming user message from another frontend (the primary, e.g.
  // agent-shell typing into the same session). Same flush model as agent.
  userChunks: string[];
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
//
// Replay handling: when we attach, the proxy replays everything cached
// for that session. We don't want each replayed event posting to Slack
// (rate limits, noise). The bridge starts in `replay` mode where every
// frame resets a quiet timer; once the timer fires (~2s of inbound
// silence) we flip to `live` and start posting. Replayed events still
// build internal state so we know about active sessions/tool calls, we
// just don't surface them.
export class SessionBridge {
  private sessions = new Map<string, SessionState>();
  // While a session's thread is being opened, concurrent notifications
  // arriving on the same sessionId all await this single promise so we
  // never open two threads or post into the channel before the parent ts
  // is known.
  private creating = new Map<string, Promise<SessionState | undefined>>();
  // sessionId -> resolver for any in-flight permission request awaiting a
  // Slack reaction.
  permissionResolvers = new Map<
    string,
    {
      requestId: string | number;
      toolCallId: string;
      options: Array<{ optionId: string; name: string; kind?: string }>;
    }
  >();

  // When backfillHistory is true, we surface every replayed event. When
  // false (the default), we discard the proxy's history replay and only
  // post Slack messages once the inbound stream has been quiet for
  // `liveQuietMs`. See SessionBridge class doc.
  private live: boolean;
  private liveTimer: NodeJS.Timeout | undefined;
  // Sessions we've learned about but haven't surfaced to Slack yet
  // (because we're still in replay). When the bridge goes live we open
  // threads for any entry here that isn't already a live SessionState.
  private discovered = new Map<
    string,
    { sessionId: string; cwd?: string; title?: string }
  >();

  // Texts of session/prompt requests we sent ourselves, kept around so we
  // can suppress the user_message_chunk that acp-multiplex synthesizes
  // back to all attached frontends (us included). FIFO per session;
  // entries time out so we don't leak if the proxy doesn't echo.
  private recentOwnPrompts = new Map<
    string,
    Array<{ text: string; at: number }>
  >();
  private static readonly OWN_PROMPT_TTL_MS = 60_000;

  constructor(private readonly opts: SessionBridgeOptions) {
    this.live = opts.config.backfillHistory;
    opts.attach.on("open", () => {
      void this.discoverSessions();
    });
    opts.attach.on("notification", (n) => {
      this.bumpLiveTimer();
      void this.onNotification(n);
    });
    opts.attach.on("request", (r) => {
      this.bumpLiveTimer();
      void this.onRequest(r);
    });
    if (!this.live) {
      this.bumpLiveTimer();
    }
  }

  // Pre-fetches metadata for any session the agent reports via
  // session/list. Does NOT open threads — agents like opencode keep their
  // entire session history here (we've seen 100+) and we'd flood Slack
  // with dormant threads. Threads still open lazily in ensureSession on
  // the first live notification for a session; discovery just lets us
  // apply the right cwd/title at that moment.
  private async discoverSessions(): Promise<void> {
    let sessions: Array<Record<string, unknown>> = [];
    try {
      const result = await this.opts.attach.request<{
        sessions?: Array<Record<string, unknown>>;
      }>("session/list", {});
      sessions = result.sessions ?? [];
    } catch (err) {
      log.debug(
        `session/list not supported on ${this.opts.attach.socketPath}: ${(err as Error).message}`,
      );
      return;
    }
    for (const s of sessions) {
      const sessionId = (s.sessionId ?? s.id) as string | undefined;
      if (!sessionId) {
        continue;
      }
      this.discovered.set(sessionId, {
        sessionId,
        cwd: typeof s.cwd === "string" ? s.cwd : undefined,
        title: typeof s.title === "string" ? s.title : undefined,
      });
    }
    log.info(
      `discovered metadata for ${this.discovered.size} session(s) on ${this.opts.attach.socketPath}`,
    );
  }

  private bumpLiveTimer(): void {
    if (this.live) {
      return;
    }
    if (this.liveTimer) {
      clearTimeout(this.liveTimer);
    }
    this.liveTimer = setTimeout(() => {
      this.live = true;
      log.info(`live: ${this.opts.attach.socketPath}`);
    }, this.opts.config.liveQuietMs);
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
    if (!this.live) {
      return; // drop replayed history; only act on live events
    }
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

    // fs/* always answered (whether replayed or live) so the agent doesn't
    // hang waiting for a response. Primary frontends already handle these.
    if (r.method.startsWith("fs/")) {
      this.opts.attach.replyError(
        r.id,
        -32601,
        "fs/* not supported by acp-slack secondary",
      );
      return;
    }

    if (!this.live) {
      // Replayed permission requests are stale (already resolved by the
      // primary). Drop without responding — the proxy will route any
      // live response through the request's original recipient.
      return;
    }

    if (r.method === "session/request_permission" && sessionId) {
      await this.handlePermissionRequest(r, sessionId, params);
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
          await this.flushUserMessage(session);
          session.agentChunks.push(text);
          log.debug(
            `agent_chunk ${sessionId.slice(0, 8)} +${text.length}ch (buf=${session.agentChunks.length})`,
          );
        }
        break;
      }
      case "user_message_chunk": {
        const content = (update.content ?? {}) as Record<string, unknown>;
        const text = (content.text ?? "") as string;
        if (text.length > 0) {
          await this.flushAgentMessage(session);
          this.closeAgentMessage(session);
          session.userChunks.push(text);
        }
        break;
      }
      case "turn_complete": {
        // Synthesized by acp-multiplex when the agent's session/prompt
        // response arrives. Finalize any open streaming agent message so
        // the next turn's chunks start a fresh Slack message.
        log.info(`turn_complete ${sessionId.slice(0, 8)}`);
        await this.flushAgentMessage(session);
        this.closeAgentMessage(session);
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
    const isFirstCard = !state || !state.threadMessageTs;
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

    // Flush any pending agent message before the tool card so thread
    // ordering mirrors event order. On the first card for this tool we
    // also close the agent message — subsequent agent chunks should land
    // in a new Slack message below the card, not silently update the
    // earlier one above it. tool_call_updates that refresh an existing
    // card don't close, so a long-running tool whose status updates
    // intermittently doesn't fragment the surrounding agent text.
    await this.flushAgentMessage(session);
    if (isFirstCard) {
      this.closeAgentMessage(session);
    }

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
      if (!session.threadTs) {
        log.warn(
          `tool_call with no threadTs for ${session.sessionId}; dropping`,
        );
        return;
      }
      const r = await this.opts.thread.postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text,
      });
      state.threadMessageTs = r.ts;
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
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const inFlight = this.creating.get(sessionId);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.createSession(sessionId, params);
    this.creating.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  private async createSession(
    sessionId: string,
    params: Record<string, unknown>,
  ): Promise<SessionState | undefined> {
    // Prefer cwd from the live notification, fall back to whatever
    // session/list told us about this sessionId.
    const known = this.discovered.get(sessionId);
    const cwd = this.cwdFromParams(params) ?? known?.cwd;
    const channel = this.resolveChannel(cwd);
    if (!channel) {
      log.warn(
        `no Slack channel resolved for sessionId=${sessionId} cwd=${cwd ?? "?"}; ` +
          `set SLACK_CHANNEL_ID or PER_PROJECT_CHANNELS=true with a known mapping`,
      );
      return undefined;
    }
    // Reattach to the thread we already opened for this session, if any.
    // The marker `_session <id>_` written into every parent-message render
    // makes this fully Slack-resident — daemon restarts (or a fresh
    // machine) rebuild the mapping on demand without any local state.
    let threadTs: string | undefined;
    const existing = await this.opts.thread.findSessionThread(
      channel,
      sessionId,
    );
    if (existing) {
      threadTs = existing;
      log.info(
        `reattached to thread ${existing} in ${channel} for sessionId=${sessionId}`,
      );
    } else {
      // Open the thread first so threadTs is known before the SessionState
      // is published into the sessions map. Otherwise concurrent
      // notifications would race in, see a session-with-no-threadTs, and
      // post unthreaded.
      const initial = renderParent({
        title: undefined,
        cwd,
        sessionId,
      });
      const r = await this.opts.thread.postMessage({
        channel,
        text: initial,
      });
      threadTs = r.threadTs;
      log.info(
        `opened thread ${r.threadTs} in ${channel} for sessionId=${sessionId}`,
      );
    }
    const session: SessionState = {
      sessionId,
      threadTs,
      channel,
      toolCalls: new Map(),
      agentChunks: [],
      agentMessageTs: undefined,
      agentLastSent: undefined,
      agentFlushChain: undefined,
      promptChain: undefined,
      userChunks: [],
      title: undefined,
      cwd,
    };
    this.sessions.set(sessionId, session);
    threadRegistry.register({
      bridge: this,
      sessionId,
      channel: session.channel,
      threadTs,
    });
    // If discovery already gave us a title, apply it so the header
    // reflects the topic immediately rather than waiting for a
    // title-changed event.
    if (known?.title) {
      await this.applyTitle(sessionId, known.title).catch(() => undefined);
    }
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
    await this.opts.thread.updateMessage(
      session.channel,
      session.threadTs,
      renderParent({ title, cwd: session.cwd, sessionId }),
    );
  }

  // Push the agent's accumulated text to Slack. First flush of a new
  // agent message posts; subsequent flushes update the same message in
  // place, so a single agent burst stays as one live Slack message even
  // if streaming has internal pauses that fire the periodic flush.
  // Chunks are NOT cleared here — closeAgentMessage finalizes and resets
  // state when something else needs to post (tool card, sibling user
  // message, turn end).
  //
  // Calls are serialized per session via agentFlushChain. Without
  // serialization, a periodic-timer flush and a turn_complete-arm flush
  // can both observe agentMessageTs === undefined, both call postMessage,
  // and produce two Slack messages for one agent burst (the second
  // replacing the first as the live message but the first lingering as
  // an orphan).
  async flushAgentMessage(session: SessionState): Promise<void> {
    const previous = session.agentFlushChain ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.flushAgentMessageWork(session));
    session.agentFlushChain = next;
    return next;
  }

  private async flushAgentMessageWork(session: SessionState): Promise<void> {
    if (session.agentChunks.length === 0) {
      return;
    }
    if (!session.threadTs) {
      log.warn(
        `flushAgentMessage with no threadTs for ${session.sessionId}; dropping`,
      );
      session.agentChunks = [];
      return;
    }
    const text = toSlackMrkdwn(session.agentChunks.join(""));
    if (!text.trim()) {
      return;
    }
    if (text === session.agentLastSent) {
      return;
    }
    if (session.agentMessageTs) {
      log.info(
        `flush update ${session.sessionId.slice(0, 8)} ts=${session.agentMessageTs} ${text.length}ch`,
      );
      await this.opts.thread.updateMessage(
        session.channel,
        session.agentMessageTs,
        text,
      );
    } else {
      log.info(
        `flush post ${session.sessionId.slice(0, 8)} ${text.length}ch`,
      );
      const r = await this.opts.thread.postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text,
      });
      session.agentMessageTs = r.ts;
    }
    session.agentLastSent = text;
  }

  // Finalize the current agent Slack message; the next agent stream will
  // start a fresh message rather than appending into this one. Call after
  // flushing whenever something else is about to post into the thread.
  private closeAgentMessage(session: SessionState): void {
    session.agentChunks = [];
    session.agentMessageTs = undefined;
    session.agentLastSent = undefined;
  }

  // Flush accumulated user-message chunks (input from another frontend
  // attached to the same session — typically the primary agent-shell
  // typing). Drops the message if it matches a prompt we just sent
  // ourselves, since acp-multiplex broadcasts the synthesized
  // user_message_chunk back to every frontend.
  async flushUserMessage(session: SessionState): Promise<void> {
    if (session.userChunks.length === 0) {
      return;
    }
    const text = session.userChunks.join("");
    session.userChunks = [];
    if (!text.trim()) {
      return;
    }
    if (this.consumeOwnPrompt(session.sessionId, text)) {
      return;
    }
    if (!session.threadTs) {
      log.warn(
        `flushUserMessage with no threadTs for ${session.sessionId}; dropping`,
      );
      return;
    }
    await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text: `:speech_balloon: ${toSlackMrkdwn(text)}`,
    });
  }

  // Convenience: post text right now, flushing any pending agent or user
  // message first to preserve ordering. Closes the agent message so any
  // subsequent agent chunks start a fresh Slack message below this one.
  private async postOrAccumulate(
    session: SessionState,
    text: string,
  ): Promise<void> {
    await this.flushUserMessage(session);
    await this.flushAgentMessage(session);
    this.closeAgentMessage(session);
    if (!session.threadTs) {
      log.warn(
        `postOrAccumulate with no threadTs for ${session.sessionId}; dropping`,
      );
      return;
    }
    await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text,
    });
  }

  // Called by the entry point on a periodic timer to flush idle text.
  async flushAll(): Promise<void> {
    for (const s of this.sessions.values()) {
      await this.flushUserMessage(s);
      await this.flushAgentMessage(s);
    }
  }

  private rememberOwnPrompt(sessionId: string, text: string): void {
    if (!text) {
      return;
    }
    const list = this.recentOwnPrompts.get(sessionId) ?? [];
    list.push({ text, at: Date.now() });
    this.recentOwnPrompts.set(sessionId, list);
  }

  private consumeOwnPrompt(sessionId: string, text: string): boolean {
    const list = this.recentOwnPrompts.get(sessionId);
    if (!list || list.length === 0) {
      return false;
    }
    const cutoff = Date.now() - SessionBridge.OWN_PROMPT_TTL_MS;
    while (list.length > 0) {
      const head = list[0];
      if (!head || head.at < cutoff) {
        list.shift();
        continue;
      }
      break;
    }
    const idx = list.findIndex((e) => e.text === text);
    if (idx === -1) {
      return false;
    }
    list.splice(idx, 1);
    return true;
  }

  // ---- Inbound (Slack -> agent) ----

  async sendUserPrompt(
    sessionId: string,
    text: string,
    images: ReadonlyArray<{ type: "image"; mimeType: string; data: string }> = [],
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn(`sendUserPrompt for unknown session ${sessionId}`);
      return;
    }
    const previous = session.promptChain ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.sendUserPromptWork(session, text, images));
    session.promptChain = next;
    return next;
  }

  private async sendUserPromptWork(
    session: SessionState,
    text: string,
    images: ReadonlyArray<{ type: "image"; mimeType: string; data: string }>,
  ): Promise<void> {
    const sessionId = session.sessionId;
    log.info(
      `prompt -> ${sessionId.slice(0, 8)}: ${text.slice(0, 80)}${images.length > 0 ? ` [+${images.length} image(s)]` : ""}`,
    );
    if (text) {
      this.rememberOwnPrompt(sessionId, text);
    }
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
    // When we are the originator, acp-multiplex excludes us from the
    // synthesized turn_complete broadcast (proxy.go: broadcastExcept).
    // The session/prompt response is the turn-end signal for this side,
    // so finalize the agent message here — otherwise the next turn's
    // chunks would chat.update into this turn's still-open message.
    log.info(`own-turn end ${sessionId.slice(0, 8)}`);
    await this.flushAgentMessage(session);
    this.closeAgentMessage(session);
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

// Render the thread's parent-message text. Always includes
// sessionMarker(sessionId) so a daemon restart can locate this thread by
// scanning channel history (ThreadClient.findSessionThread). Title and
// cwd are optional — title is unset until the agent emits a
// session/title-changed; cwd may be missing for sessions that don't
// expose one.
function renderParent(opts: {
  title: string | undefined;
  cwd: string | undefined;
  sessionId: string;
}): string {
  const heading = opts.title ?? (opts.cwd ? basename(opts.cwd) : opts.sessionId);
  const cwdLine = opts.cwd ? `\n_${opts.cwd}_` : "";
  return `:robot_face: *${heading}*${cwdLine}\n${sessionMarker(opts.sessionId)}`;
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
