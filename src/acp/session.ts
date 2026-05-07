import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
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
  // Per-session agent state observed from streaming notifications.
  // modeId tracks current_mode_update; modelId tracks
  // current_model_update (acp-multiplex synthesizes both on the
  // corresponding session/set_* responses). Usage fields track
  // usage_update notifications: contextUsed/Size are token counts
  // for the active context window; cost is the running cost the
  // agent reports for the session.
  modeId: string | undefined;
  modelId: string | undefined;
  contextUsed: number | undefined;
  contextSize: number | undefined;
  costAmount: number | undefined;
  costCurrency: string | undefined;
  // Per-turn collapsed spinner state. While the agent is running tools,
  // a single Slack message replaces the per-tool-call cards: collapsed
  // to ":hourglass_flowing_sand: _working..._" by default, expanded to
  // a header list of tool calls when the user reacts :eyes: on it.
  // Deleted entirely at turn end so the thread doesn't accumulate
  // mechanical tool-call clutter.
  spinnerTs: string | undefined;
  spinnerExpanded: boolean;
  // Tool-call ids that have appeared in this turn, in order, so the
  // expanded view can list them. The full state for each is in
  // session.toolCalls (keyed by id). Cleared on turn end.
  turnToolCallIds: string[];
  // Per-session spinner serializer. Without this, two tool-call
  // notifications arriving close together both see spinnerTs ===
  // undefined, both call postMessage, and produce two Slack spinner
  // messages — only the second's ts gets stored, so the first is
  // orphaned and never updated/finalized. Same race shape as
  // agentFlushChain.
  spinnerChain: Promise<void> | undefined;
  // Wall-clock time (ms since epoch) when the current spinner was
  // posted. Used to render an elapsed-time indicator on the spinner
  // head so the user can see the agent is still alive on long turns.
  // Cleared at finalize.
  spinnerStartedAt: number | undefined;
  // Slack ts of the current turn's plan message. Each plan
  // notification redelivers the full updated plan, so we chat.update
  // in place rather than posting a fresh message per delta. Cleared
  // at turn end alongside the spinner.
  planTs: string | undefined;
  // 30-second timer that re-renders the spinner so its elapsed-time
  // suffix advances during long turns. Cleared at finalize and on
  // bridge cleanup.
  spinnerTicker: NodeJS.Timeout | undefined;
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
      // Slack ts of the posted ":lock: Permission requested" message.
      // Captured so that an acp-multiplex/permission_resolved notification
      // (sent when another frontend answers first) can chat.delete the
      // stale prompt instead of leaving it as zombie UI.
      promptTs: string | undefined;
      promptChannel: string | undefined;
    }
  >();
  // Human-readable name for this proxy/bridge, set via the proxy's
  // ACP_MULTIPLEX_NAME env var and delivered as the first frame on a
  // secondary attach (acp-multiplex/meta notification). Per-proxy, not
  // per-session, so the same name applies to every session that runs in
  // the same agent process. Used as a fallback heading in renderParent
  // between the agent-supplied title and basename(cwd).
  private bridgeName: string | undefined;

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
      void this.discoverSessions().then(() => this.eagerAttachThreads());
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
    // Log the shape of the first session entry so we can see what fields
    // the agent actually returns beyond what we currently consume
    // (sessionId/cwd/title). Useful for surfacing more data later.
    if (sessions.length > 0 && sessions[0]) {
      log.info(
        `session/list entry shape: ${Object.keys(sessions[0]).sort().join(", ")}`,
      );
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

  // After discoverSessions, scan each relevant Slack channel once and
  // pre-register thread mappings for any session whose marker we find.
  // This makes inbound Slack messages route correctly *before* the
  // session emits any agent-side notification — without this, typing
  // into a thread for a quiet session lands at threadRegistry with no
  // entry and gets dropped as "no bridge for thread."
  //
  // Cost: one conversations.history scan per unique target channel,
  // capped by findSessionThreadsInChannel's 1000-message safety. The
  // lazy createSession path still kicks in for any session we miss.
  private async eagerAttachThreads(): Promise<void> {
    const channelToSessionIds = new Map<string, string[]>();
    for (const [sessionId, meta] of this.discovered) {
      const channel = this.resolveChannel(meta.cwd);
      if (!channel) {
        continue;
      }
      const list = channelToSessionIds.get(channel) ?? [];
      list.push(sessionId);
      channelToSessionIds.set(channel, list);
    }
    for (const [channel, sessionIds] of channelToSessionIds) {
      const matches = await this.opts.thread.findSessionThreadsInChannel(
        channel,
      );
      let attached = 0;
      for (const sessionId of sessionIds) {
        const threadTs = matches.get(sessionId);
        if (!threadTs) {
          continue;
        }
        if (this.materializeFromMarker(sessionId, channel, threadTs)) {
          attached++;
        }
      }
      log.info(
        `eager-attached ${attached} thread(s) in ${channel} (scanned ${matches.size} marker(s))`,
      );
    }
  }

  // Build a SessionState from a sessionId + thread we already opened in
  // a previous daemon lifetime, without posting anything new. Returns
  // false if a SessionState already exists (e.g. a live notification
  // raced ahead of eager attach and triggered createSession).
  private materializeFromMarker(
    sessionId: string,
    channel: string,
    threadTs: string,
  ): boolean {
    if (this.sessions.has(sessionId)) {
      return false;
    }
    const known = this.discovered.get(sessionId);
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
      title: known?.title,
      cwd: known?.cwd,
      modeId: undefined,
      modelId: undefined,
      contextUsed: undefined,
      contextSize: undefined,
      costAmount: undefined,
      costCurrency: undefined,
      spinnerTs: undefined,
      spinnerExpanded: false,
      turnToolCallIds: [],
      spinnerChain: undefined,
      spinnerStartedAt: undefined,
      spinnerTicker: undefined,
      planTs: undefined,
    };
    this.sessions.set(sessionId, session);
    threadRegistry.register({
      bridge: this,
      sessionId,
      channel,
      threadTs,
    });
    return true;
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
    const params = (n.params ?? {}) as Record<string, unknown>;
    // acp-multiplex/meta is delivered as the very first frame on a
    // secondary attach (cache.go: meta replays before initialize).
    // It's proxy-level metadata, not session activity, so handle it
    // before the live-gate would drop it as "replayed history."
    // A sibling frontend answered a permission request before us. Tear
    // down our (now-stale) Slack prompt. Lives outside the live-gate
    // because — like meta — it's a transient proxy-level signal, not
    // session activity. Idempotent: if we don't have an entry for the
    // requestId, no-op.
    if (n.method === "acp-multiplex/permission_resolved") {
      const requestId = params.requestId as string | number | undefined;
      if (requestId === undefined) {
        return;
      }
      for (const [sessionId, entry] of this.permissionResolvers) {
        if (entry.requestId === requestId) {
          await this.resolvePermissionEntry(sessionId, entry).catch(
            () => undefined,
          );
          return;
        }
      }
      return;
    }

    if (n.method === "acp-multiplex/meta") {
      const name = typeof params.name === "string" ? params.name : undefined;
      if (name && name !== this.bridgeName) {
        this.bridgeName = name;
        log.info(`bridge name: ${name}`);
        // Refresh any threads we've already opened so they pick up the
        // new heading. Usually this is empty (meta arrives during the
        // initial replay window before the bridge has gone live and
        // opened any thread), but we re-render defensively.
        for (const session of this.sessions.values()) {
          await this.refreshParent(session).catch(() => undefined);
        }
      }
      return;
    }

    if (!this.live) {
      return; // drop replayed history; only act on live events
    }
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

  // Re-render the thread parent with the current state. Used when
  // proxy-level metadata (e.g. bridgeName) arrives after a thread is
  // already open, or any other case where the heading inputs change
  // outside of session/title-changed.
  private async refreshParent(session: SessionState): Promise<void> {
    if (!session.threadTs) {
      return;
    }
    await this.opts.thread.updateMessage(
      session.channel,
      session.threadTs,
      renderParent({
        title: session.title,
        cwd: session.cwd,
        sessionId: session.sessionId,
        bridgeName: this.bridgeName,
        agentName: this.opts.attach.agentInfo?.name,
        modelId: session.modelId,
        modeId: session.modeId,
        contextUsed: session.contextUsed,
        contextSize: session.contextSize,
        costAmount: session.costAmount,
        costCurrency: session.costCurrency,
      }),
    );
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
    // A session/update arriving here means our agent process is the
    // live owner of this session — even if multiple bridges registered
    // the same thread on attach. Promote so subsequent inbound Slack
    // messages route to us first.
    if (session.threadTs) {
      threadRegistry.promote(this, session.channel, session.threadTs);
    }

    switch (kind) {
      case "agent_thought_chunk": {
        // We don't surface thought content in Slack (it's noisy and
        // intentionally a diagnostic view in agent-shell), but the
        // existence is the earliest signal that a turn is actually
        // running. Post the spinner now so the user has proof of life
        // before any agent text or tool call materializes.
        await this.ensureSpinner(session);
        break;
      }
      case "agent_message_chunk": {
        const content = (update.content ?? {}) as Record<string, unknown>;
        const text = (content.text ?? "") as string;
        if (text.length > 0) {
          await this.flushUserMessage(session);
          await this.ensureSpinner(session);
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
        // the next turn's chunks start a fresh Slack message, and
        // transform the per-turn spinner into a static marker. The
        // stopReason carries through to the marker so a user-cancelled
        // turn (agent-shell C-c, etc.) reads as "cancelled" rather
        // than the success default.
        const stopReason = update.stopReason as string | undefined;
        log.info(
          `turn_complete ${sessionId.slice(0, 8)}${stopReason ? ` (${stopReason})` : ""}`,
        );
        await this.flushAgentMessage(session);
        this.closeAgentMessage(session);
        await this.finalizeSpinner(session, stopReason);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        await this.handleToolCallUpdate(session, update);
        break;
      }
      case "plan": {
        // Each plan notification re-emits the full plan with updated
        // per-step statuses. Post the first one as a fresh message,
        // then chat.update in place on subsequent deltas so the
        // single plan message evolves rather than the thread filling
        // with restated copies.
        const planText = renderPlan(update);
        if (planText) {
          await this.upsertPlan(session, planText);
        }
        break;
      }
      case "current_mode_update": {
        const newMode = update.currentModeId as string | undefined;
        if (newMode && session.modeId !== newMode) {
          session.modeId = newMode;
          await this.refreshParent(session).catch(() => undefined);
        }
        break;
      }
      case "current_model_update": {
        const newModel = update.currentModelId as string | undefined;
        if (newModel && session.modelId !== newModel) {
          session.modelId = newModel;
          await this.refreshParent(session).catch(() => undefined);
        }
        break;
      }
      case "usage_update": {
        // Shape: {used, size, cost: {amount, currency}}. Track diffs
        // so unchanged updates don't churn chat.update calls on the
        // parent — usage_update can fire multiple times within a turn.
        const used = update.used as number | undefined;
        const size = update.size as number | undefined;
        const cost = (update.cost ?? {}) as Record<string, unknown>;
        const amount = cost.amount as number | undefined;
        const currency = cost.currency as string | undefined;
        let changed = false;
        if (typeof used === "number" && session.contextUsed !== used) {
          session.contextUsed = used;
          changed = true;
        }
        if (typeof size === "number" && session.contextSize !== size) {
          session.contextSize = size;
          changed = true;
        }
        if (typeof amount === "number" && session.costAmount !== amount) {
          session.costAmount = amount;
          changed = true;
        }
        if (typeof currency === "string" && session.costCurrency !== currency) {
          session.costCurrency = currency;
          changed = true;
        }
        if (changed) {
          await this.refreshParent(session).catch(() => undefined);
        }
        break;
      }
      case "available_commands_update":
      case "config_option_update":
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

    const optionLines = options
      .map(
        (o) =>
          `   • \`${o.optionId}\`  ${o.name}` + (o.kind ? `  _(${o.kind})_` : ""),
      )
      .join("\n");
    const text =
      `:lock: *Permission requested*\n${title}\n${optionLines}\n` +
      `_react :white_check_mark: to allow once, :unlock: to allow always, :x: to reject_`;
    const promptTs = await this.postOrAccumulate(session, text);
    this.permissionResolvers.set(sessionId, {
      requestId: r.id,
      toolCallId,
      options,
      promptTs,
      promptChannel: session.channel,
    });
  }

  // Resolve a permission entry: clear from the resolver map and, if the
  // prompt was actually posted to Slack, delete it. Used both when a
  // sibling frontend answered first (acp-multiplex/permission_resolved
  // notification) and when this client itself answered (so we can drop
  // the now-irrelevant prompt — the user already gave their reaction).
  private async resolvePermissionEntry(
    sessionId: string,
    entry: NonNullable<ReturnType<typeof this.permissionResolvers.get>>,
  ): Promise<void> {
    this.permissionResolvers.delete(sessionId);
    if (entry.promptTs && entry.promptChannel) {
      await this.opts.thread.deleteMessage(
        entry.promptChannel,
        entry.promptTs,
      );
    }
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
    const isNewTool = !state;
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
      session.turnToolCallIds.push(toolCallId);
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

    // Flush and close any pending agent message before the spinner so
    // thread ordering mirrors event order. closeAgentMessage only fires
    // on the first tool of the turn — subsequent tool updates within the
    // turn don't disturb the surrounding agent prose.
    await this.flushAgentMessage(session);
    if (isNewTool && session.turnToolCallIds.length === 1) {
      this.closeAgentMessage(session);
    }

    await this.refreshSpinner(session);
  }

  // Post or update the per-turn collapsed-spinner message. Replaces the
  // previous one-Slack-message-per-tool-call rendering: every tool call
  // in a turn merges into a single message that the user can either
  // ignore (default) or expand inline by reacting :eyes:. At turn end
  // finalizeSpinner transforms it into a small static marker between
  // prompts and answers, so the thread keeps visible structure without
  // accumulating tool-call clutter.
  //
  // Calls are serialized per session via spinnerChain. Without
  // serialization, rapid tool_call notifications race on spinnerTs:
  // two refreshes observe it undefined, both POST, the second's ts
  // overwrites the first in state, and the first message is orphaned
  // as a permanent "working..." in Slack.
  private async refreshSpinner(session: SessionState): Promise<void> {
    const previous = session.spinnerChain ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.refreshSpinnerWork(session));
    session.spinnerChain = next;
    return next;
  }

  private async refreshSpinnerWork(session: SessionState): Promise<void> {
    if (!session.threadTs) {
      log.warn(
        `refreshSpinner with no threadTs for ${session.sessionId}; dropping`,
      );
      return;
    }
    const text = renderSpinner(session);
    if (session.spinnerTs) {
      await this.opts.thread.updateMessage(
        session.channel,
        session.spinnerTs,
        text,
      );
    } else {
      const r = await this.opts.thread.postMessage({
        channel: session.channel,
        threadTs: session.threadTs,
        text,
      });
      session.spinnerTs = r.ts;
      session.spinnerStartedAt = Date.now();
      this.startSpinnerTicker(session);
    }
  }

  // Post the per-turn spinner if it isn't up yet. Called from the
  // earliest indicators of agent activity (agent_thought_chunk,
  // agent_message_chunk) so the spinner appears as soon as the turn
  // is moving — not just when the first tool_call fires. After the
  // spinner exists, agent text and tool updates use refreshSpinner
  // directly; no need to call ensureSpinner repeatedly.
  private async ensureSpinner(session: SessionState): Promise<void> {
    if (session.spinnerTs) {
      return;
    }
    await this.refreshSpinner(session);
  }

  // 30-second ticker that re-renders the spinner so its elapsed-time
  // suffix advances on long turns. Provides proof of life — if the
  // suffix keeps advancing the agent is still doing something. Each
  // tick goes through refreshSpinner, so it queues on spinnerChain
  // alongside tool-call updates and never races on spinnerTs.
  private startSpinnerTicker(session: SessionState): void {
    if (session.spinnerTicker) {
      return;
    }
    session.spinnerTicker = setInterval(() => {
      if (!session.spinnerTs) {
        return;
      }
      void this.refreshSpinner(session).catch(() => undefined);
    }, 30_000);
  }

  private stopSpinnerTicker(session: SessionState): void {
    if (session.spinnerTicker) {
      clearInterval(session.spinnerTicker);
      session.spinnerTicker = undefined;
    }
  }

  // Transform the per-turn spinner into a quiet, static "turn ran"
  // marker. Called at turn end from both the turn_complete arm
  // (sibling-driven turns) and the sendUserPromptWork tail (own turns).
  //
  // We deliberately do NOT chat.delete the message — keeping a one-line
  // marker between turns gives the thread visible structure. If the
  // user reacted :eyes: during the turn the expanded form (tool list)
  // is preserved in the finalized text so they don't lose what they
  // were watching when the turn ended. Idempotent — no-op if the
  // spinner was never created.
  // Called by the entry point on bridge close (attach.on("close")).
  // Stops anything timer-based we own per session so the bridge object
  // can be garbage-collected and we don't keep firing intervals against
  // a torn-down attach.
  cleanup(): void {
    for (const session of this.sessions.values()) {
      this.stopSpinnerTicker(session);
    }
  }

  private async finalizeSpinner(
    session: SessionState,
    stopReason?: string,
  ): Promise<void> {
    // Stop the ticker synchronously so it can't fire a refresh after
    // we've cleared spinnerTs (which would post a fresh spinner).
    this.stopSpinnerTicker(session);
    // Queue behind any in-flight refresh so we can't observe spinnerTs
    // before a pending postMessage has set it (which would skip the
    // update and leave a zombie "working..." spinner in the thread).
    const previous = session.spinnerChain ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.finalizeSpinnerWork(session, stopReason));
    session.spinnerChain = next;
    return next;
  }

  private async finalizeSpinnerWork(
    session: SessionState,
    stopReason?: string,
  ): Promise<void> {
    const ts = session.spinnerTs;
    const expanded = session.spinnerExpanded;
    const count = session.turnToolCallIds.length;
    const elapsed = session.spinnerStartedAt
      ? Date.now() - session.spinnerStartedAt
      : 0;
    const elapsedSuffix = elapsed > 0 ? ` (${formatElapsed(elapsed)})` : "";
    const head = renderFinalMarker(count, elapsedSuffix, stopReason);
    const text = expanded
      ? renderSpinnerExpanded(session, head)
      : head;
    session.spinnerTs = undefined;
    session.spinnerExpanded = false;
    session.turnToolCallIds = [];
    session.spinnerStartedAt = undefined;
    session.planTs = undefined;
    if (!ts) {
      return;
    }
    await this.opts.thread.updateMessage(session.channel, ts, text);
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
        bridgeName: this.bridgeName,
        agentName: this.opts.attach.agentInfo?.name,
        modelId: undefined,
        modeId: undefined,
        contextUsed: undefined,
        contextSize: undefined,
        costAmount: undefined,
        costCurrency: undefined,
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
      modeId: undefined,
      modelId: undefined,
      contextUsed: undefined,
      contextSize: undefined,
      costAmount: undefined,
      costCurrency: undefined,
      spinnerTs: undefined,
      spinnerExpanded: false,
      turnToolCallIds: [],
      spinnerChain: undefined,
      spinnerStartedAt: undefined,
      spinnerTicker: undefined,
      planTs: undefined,
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
      renderParent({
        title,
        cwd: session.cwd,
        sessionId,
        bridgeName: this.bridgeName,
        agentName: this.opts.attach.agentInfo?.name,
        modelId: session.modelId,
        modeId: session.modeId,
        contextUsed: session.contextUsed,
        contextSize: session.contextSize,
        costAmount: session.costAmount,
        costCurrency: session.costCurrency,
      }),
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
  // Post or update the per-turn plan message. First call posts; later
  // calls chat.update the same ts so a single plan evolves in place.
  // Cleared at turn end (finalizeSpinnerWork) so the next turn starts
  // a fresh plan message.
  private async upsertPlan(
    session: SessionState,
    planText: string,
  ): Promise<void> {
    const text = `*Plan*\n${planText}`;
    if (session.planTs) {
      await this.opts.thread.updateMessage(
        session.channel,
        session.planTs,
        text,
      );
      return;
    }
    // Flush any in-flight agent stream so the plan message lands at
    // the right point in thread order, then post.
    await this.flushUserMessage(session);
    await this.flushAgentMessage(session);
    this.closeAgentMessage(session);
    if (!session.threadTs) {
      log.warn(
        `upsertPlan with no threadTs for ${session.sessionId}; dropping`,
      );
      return;
    }
    const r = await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text,
    });
    session.planTs = r.ts;
  }

  private async postOrAccumulate(
    session: SessionState,
    text: string,
  ): Promise<string | undefined> {
    await this.flushUserMessage(session);
    await this.flushAgentMessage(session);
    this.closeAgentMessage(session);
    if (!session.threadTs) {
      log.warn(
        `postOrAccumulate with no threadTs for ${session.sessionId}; dropping`,
      );
      return undefined;
    }
    const r = await this.opts.thread.postMessage({
      channel: session.channel,
      threadTs: session.threadTs,
      text,
    });
    return r.ts;
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
    const response = await this.opts.attach.request<{
      stopReason?: string;
    }>("session/prompt", {
      sessionId,
      prompt,
    });
    // When we are the originator, acp-multiplex excludes us from the
    // synthesized turn_complete broadcast (proxy.go: broadcastExcept).
    // The session/prompt response is the turn-end signal for this side,
    // so finalize the agent message here — otherwise the next turn's
    // chunks would chat.update into this turn's still-open message.
    const stopReason = response?.stopReason;
    log.info(
      `own-turn end ${sessionId.slice(0, 8)}${stopReason ? ` (${stopReason})` : ""}`,
    );
    await this.flushAgentMessage(session);
    this.closeAgentMessage(session);
    await this.finalizeSpinner(session, stopReason);
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
    if (optionId === "cancel") {
      this.opts.attach.reply(pending.requestId, {
        outcome: { outcome: "cancelled" },
      });
    } else {
      this.opts.attach.reply(pending.requestId, {
        outcome: { outcome: "selected", optionId },
      });
    }
    // Clear the entry and remove the now-resolved Slack prompt. The user
    // reacted, the agent has its answer; leaving the lock prompt around
    // would clutter the thread and tempt accidental re-reactions.
    await this.resolvePermissionEntry(sessionId, pending);
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
      case "allow_always":
      case "deny":
        if (!added) {
          return;
        }
        await this.handleAllowDeny(sessionId, action);
        return;
      case "cancel":
        // Only meaningful on the active spinner. Sends session/cancel
        // to the agent; the agent's response (with stopReason
        // "cancelled") flows through turn_complete (or our await on
        // session/prompt for own turns) and finalizes the spinner with
        // a "cancelled" marker.
        if (!added) {
          return;
        }
        if (session.spinnerTs !== ts) {
          return;
        }
        log.info(`cancel <- slack ${sessionId.slice(0, 8)}`);
        this.opts.attach.notify("session/cancel", { sessionId });
        return;
      case "hide":
        if (added) {
          await this.hideMessage(channel, ts);
        } else {
          await this.unhideMessage(channel, ts);
        }
        return;
      case "expand_truncated":
        // :eyes: on the per-turn spinner toggles whether the spinner
        // shows just "working..." or expands to the running list of
        // tool calls. Falls through to the normal truncated-content
        // expand for any other message.
        if (session.spinnerTs === ts) {
          session.spinnerExpanded = added;
          await this.refreshSpinner(session).catch(() => undefined);
          return;
        }
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
    action: "allow" | "allow_always" | "deny",
  ): Promise<void> {
    const pending = this.permissionResolvers.get(sessionId);
    if (!pending) {
      return;
    }
    // Map the reaction to a kind ordering. The first option whose kind
    // matches in priority order wins; if nothing matches we fall back to
    // the agent's first option (some agents don't tag option kinds).
    const priority: ReadonlyArray<string> =
      action === "allow_always"
        ? ["allow_always", "allow_once"]
        : action === "allow"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
    let opt: typeof pending.options[number] | undefined;
    for (const want of priority) {
      opt = pending.options.find((o) => o.kind === want);
      if (opt) {
        break;
      }
    }
    opt = opt ?? pending.options[0];
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
// scanning channel history (ThreadClient.findSessionThread).
//
// Heading priority:
//   title       — agent-supplied per-session, e.g. via session/title-changed
//   bridgeName  — proxy-supplied per-process via ACP_MULTIPLEX_NAME and the
//                 acp-multiplex/meta notification; same name across every
//                 session running in that proxy
//   basename(cwd) — derived per-session
//   none        — fall back to just the marker line, since the only thing
//                 left would be the sessionId, which already appears in
//                 the marker
//
// Layout below the title (each line omitted when the inputs aren't known):
//   1. cwd path with the daemon's hostname appended ("_/path_ on `host`")
//      — disambiguates threads when running multiple acp-slack daemons
//      against the same Slack workspace.
//   2. Agent / model / mode / usage stats on one packed line, with
//      identifiers wrapped in backticks for monospace contrast (Slack
//      mrkdwn doesn't support color).
//   3. Session marker (italic, contains the full sessionId for the
//      grep-based reattach path).
function renderParent(opts: {
  title: string | undefined;
  cwd: string | undefined;
  sessionId: string;
  bridgeName: string | undefined;
  agentName: string | undefined;
  modelId: string | undefined;
  modeId: string | undefined;
  contextUsed: number | undefined;
  contextSize: number | undefined;
  costAmount: number | undefined;
  costCurrency: string | undefined;
}): string {
  const heading =
    opts.title ?? opts.bridgeName ?? (opts.cwd ? basename(opts.cwd) : undefined);
  const lines: string[] = [];
  if (heading) {
    lines.push(`:robot_face: *${heading}*`);
  }
  if (opts.cwd) {
    lines.push(`_${opts.cwd}_ on \`${daemonHost}\``);
  } else {
    lines.push(`on \`${daemonHost}\``);
  }
  const metaParts: string[] = [];
  const agent = friendlyAgent(opts.agentName);
  if (agent) {
    metaParts.push(`\`${agent}\``);
  }
  if (opts.modelId) {
    metaParts.push(`\`${opts.modelId}\``);
  }
  if (opts.modeId) {
    metaParts.push(`mode \`${opts.modeId}\``);
  }
  if (typeof opts.contextUsed === "number" || typeof opts.contextSize === "number") {
    const used = formatTokens(opts.contextUsed);
    const size = formatTokens(opts.contextSize);
    metaParts.push(`\`${used}\`/\`${size}\``);
  }
  if (typeof opts.costAmount === "number") {
    const cur = opts.costCurrency ?? "USD";
    metaParts.push(`\`${formatCost(opts.costAmount, cur)}\``);
  }
  if (metaParts.length > 0) {
    lines.push(metaParts.join(" · "));
  }
  lines.push(sessionMarker(opts.sessionId));
  return lines.join("\n");
}

const daemonHost = hostname().split(".")[0] ?? hostname();

// Strip the npm-style scope prefix from agentInfo.name so a name like
// "@agentclientprotocol/claude-agent-acp" displays as the bare package
// name "claude-agent-acp". Most ACP agents publish under a scope; for
// presentation the scope is uninformative noise.
function friendlyAgent(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  const m = name.match(/^@[^/]+\/(.+)$/);
  return m?.[1] ?? name;
}

function formatTokens(n: number | undefined): string {
  if (typeof n !== "number") {
    return "?";
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(0)}k`;
  }
  return `${n}`;
}

function formatCost(amount: number, currency: string): string {
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${sym}${amount.toFixed(2)}`;
}

// Render the per-turn spinner message. Collapsed by default — just an
// hourglass and "working..." — so a turn that does ten tool calls
// occupies one line in the thread instead of ten cards. When the user
// reacts :eyes: on the spinner, spinnerExpanded flips to true and the
// list of tool calls in this turn appears inline below the spinner
// header. Removing the reaction collapses again.
//
// After 30s of elapsed time the head grows an "(elapsed)" suffix that
// updates every 30s via the spinner ticker (see startSpinnerTicker).
// This serves as proof of life on long-running turns.
function renderSpinner(session: SessionState): string {
  const elapsed = session.spinnerStartedAt
    ? Date.now() - session.spinnerStartedAt
    : 0;
  const suffix =
    elapsed >= 30_000 ? ` (${formatElapsed(elapsed)})` : "";
  const head = `:hourglass_flowing_sand: _working...${suffix}_`;
  if (!session.spinnerExpanded) {
    return head;
  }
  return renderSpinnerExpanded(session, head);
}

// Compose the static turn-end marker. Picks an icon and label based on
// the stopReason carried on turn_complete (or session/prompt response
// for own turns). end_turn / no reason → success; cancelled → an
// explicit "cancelled" indicator so a user-interrupted turn doesn't
// look like a normal completion; other non-success reasons (refusal,
// max_tokens, etc.) use a warning icon and include the reason text.
function renderFinalMarker(
  count: number,
  elapsedSuffix: string,
  stopReason: string | undefined,
): string {
  if (stopReason === "cancelled") {
    const body =
      count > 0
        ? `cancelled · ${count} tool${count === 1 ? "" : "s"}${elapsedSuffix}`
        : `cancelled${elapsedSuffix}`;
    return `:no_entry: _${body}_`;
  }
  if (stopReason && stopReason !== "end_turn") {
    const body =
      count > 0
        ? `${stopReason} · ${count} tool${count === 1 ? "" : "s"}${elapsedSuffix}`
        : `${stopReason}${elapsedSuffix}`;
    return `:warning: _${body}_`;
  }
  const body =
    count > 0
      ? `${count} tool${count === 1 ? "" : "s"}${elapsedSuffix}`
      : `done${elapsedSuffix}`;
  return `:white_check_mark: _${body}_`;
}

// Compact human-readable elapsed-time formatter.
//   0s..59s    → "Xs"
//   1m..59m    → "Xm" or "Xm Ys" if Y > 0
//   1h+        → "Xh" or "Xh Ym" if Y > 0
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) {
    return remSec > 0 ? `${totalMin}m ${remSec}s` : `${totalMin}m`;
  }
  const totalHr = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin > 0 ? `${totalHr}h ${remMin}m` : `${totalHr}h`;
}

// Tool-list rendering shared between the active spinner (when :eyes:
// is reacted) and finalizeSpinner's preservation of the expanded view
// when a turn ends with the user still watching. `head` is the line
// shown above the list — the active "working..." or the finalized
// ":white_check_mark: _N tools_".
function renderSpinnerExpanded(session: SessionState, head: string): string {
  const lines = [head];
  for (const id of session.turnToolCallIds) {
    const tc = session.toolCalls.get(id);
    if (!tc) {
      continue;
    }
    lines.push(
      renderToolCallHeader({
        status: tc.status,
        title: tc.title,
        kind: tc.kind,
      }),
    );
  }
  return lines.join("\n");
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
