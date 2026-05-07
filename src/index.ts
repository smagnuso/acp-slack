#!/usr/bin/env node
import { AcpAttach } from "./acp/attach.js";
import { SessionBridge } from "./acp/session.js";
import { configPath, loadConfig } from "./config.js";
import { createSlackApp } from "./slack/app.js";
import { ThreadClient } from "./slack/thread.js";
import { SocketWatcher } from "./socket-watcher.js";
import { ChannelMap } from "./storage/channels.js";
import { HiddenStore } from "./storage/hidden.js";
import { TruncatedStore } from "./storage/truncated.js";
import { threadRegistry } from "./slack/registry.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("main");

interface AttachContext {
  attach: AcpAttach;
  bridge: SessionBridge;
}

async function main(): Promise<void> {
  const path = configPath();
  const config = loadConfig(path);
  setDebug(config.debug);

  log.info(`config loaded from ${path}`);
  log.info(`socket dir: ${config.socketDir}`);
  log.info(
    `authorized users: ${config.authorizedUsers.size > 0 ? Array.from(config.authorizedUsers).join(",") + " (whitelist)" : "(empty — all Slack users allowed)"}`,
  );

  const slack = createSlackApp(config);
  await slack.start();
  const thread = new ThreadClient(slack.app);
  const channels = new ChannelMap(config.channelsFile);
  const truncatedStore = new TruncatedStore(config.truncatedMessagesDir);
  const hiddenStore = new HiddenStore(config.hiddenMessagesDir);

  const bridges = new Map<string, AttachContext>();

  // Periodic flusher: agent-message chunks accumulate until we observe a
  // pause (~750 ms) or a tool call begins, so we don't post one Slack
  // message per token. flushAll() is idempotent.
  const FLUSH_INTERVAL_MS = 750;
  const flushTimer = setInterval(() => {
    for (const ctx of bridges.values()) {
      void ctx.bridge.flushAll().catch((err: unknown) => {
        log.warn(`flush error: ${(err as Error).message}`);
      });
    }
  }, FLUSH_INTERVAL_MS);

  // Watchdog: log a warning if a socket has been silent past the staleness
  // threshold. Sockets are local Unix so silence usually means the agent
  // is idle, not that the connection died — informational only.
  const WATCHDOG_INTERVAL_MS = 60_000;
  const watchdog = setInterval(() => {
    const now = Date.now();
    const limitMs = config.websocketStaleThreshold * 1000;
    for (const ctx of bridges.values()) {
      const idleMs = now - ctx.attach.lastFrameTime;
      if (idleMs > limitMs) {
        log.warn(
          `socket ${ctx.attach.socketPath} silent for ${Math.round(idleMs / 1000)}s`,
        );
      }
    }
  }, WATCHDOG_INTERVAL_MS);

  const watcher = new SocketWatcher({
    dir: config.socketDir,
    onAdd(socketPath) {
      log.info(`socket added: ${socketPath}`);
      const attach = new AcpAttach({ socketPath });
      const bridge = new SessionBridge({
        attach,
        config,
        thread,
        channels,
        truncatedStore,
        hiddenStore,
      });
      attach.on("close", () => {
        threadRegistry.unregisterBridge(bridge);
        bridges.delete(socketPath);
      });
      attach.on("error", (err) => {
        log.warn(`attach error: ${err.message}`);
      });
      attach.start();
      bridges.set(socketPath, { attach, bridge });
    },
    onRemove(socketPath) {
      log.info(`socket removed: ${socketPath}`);
      const ctx = bridges.get(socketPath);
      if (ctx) {
        ctx.attach.stop();
        bridges.delete(socketPath);
      }
    },
  });
  watcher.start();

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    clearInterval(flushTimer);
    clearInterval(watchdog);
    try {
      await watcher.stop();
      // Flush any pending text before tearing down.
      for (const ctx of bridges.values()) {
        await ctx.bridge.flushAll().catch(() => undefined);
        ctx.attach.stop();
      }
      bridges.clear();
      await slack.stop();
    } catch (err) {
      log.error("stop error", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
