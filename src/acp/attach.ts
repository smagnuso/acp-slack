import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { NdjsonParser } from "../util/ndjson.js";
import { logger } from "../util/log.js";
import {
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  isNotification,
  isRequest,
  isResponse,
} from "./protocol.js";

const log = logger("acp");

export interface AttachOptions {
  socketPath: string;
  // Initialize params to send right after connect. Sent unconditionally so the
  // proxy starts replaying its cached history immediately.
  clientCapabilities?: Record<string, unknown>;
  protocolVersion?: number;
}

export interface AttachEvents {
  "open": [];
  "close": [{ hadError: boolean }];
  "error": [Error];
  "request": [JsonRpcRequest];
  "notification": [JsonRpcNotification];
  "response": [JsonRpcResponse];
}

interface PendingRequest {
  resolve: (r: JsonRpcResponse) => void;
  reject: (err: Error) => void;
}

export class AcpAttach extends EventEmitter<AttachEvents> {
  private sock: Socket | undefined;
  private parser: NdjsonParser;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private connected = false;
  // Track time of last received message — used by staleness detection.
  private lastFrameAt = 0;

  constructor(private readonly opts: AttachOptions) {
    super();
    this.parser = new NdjsonParser(
      (m) => this.onMessage(m as JsonRpcMessage),
      (err, raw) => {
        log.warn(
          `parse error on ${this.opts.socketPath}: ${err.message}; raw=${raw.slice(0, 200)}`,
        );
      },
    );
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get lastFrameTime(): number {
    return this.lastFrameAt;
  }

  start(): void {
    log.debug(`connecting ${this.opts.socketPath}`);
    const sock = createConnection(this.opts.socketPath);
    sock.setEncoding("utf8");
    this.sock = sock;

    sock.on("connect", () => {
      this.connected = true;
      this.lastFrameAt = Date.now();
      log.info(`attached ${this.opts.socketPath}`);
      // Send initialize first; only emit "open" once the agent has
      // acknowledged it, so listeners that want to send follow-up
      // requests (session/list, etc.) don't race ahead of the handshake.
      this.request("initialize", {
        protocolVersion: this.opts.protocolVersion ?? 1,
        clientCapabilities: this.opts.clientCapabilities ?? {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })
        .catch((err: Error) => {
          log.warn(
            `initialize failed on ${this.opts.socketPath}: ${err.message}`,
          );
        })
        .finally(() => {
          this.emit("open");
        });
    });

    sock.on("data", (chunk) => {
      this.lastFrameAt = Date.now();
      this.parser.push(chunk);
    });

    sock.on("error", (err) => {
      log.warn(`socket error ${this.opts.socketPath}: ${err.message}`);
      this.emit("error", err);
    });

    sock.on("close", (hadError) => {
      this.connected = false;
      this.parser.flush();
      log.info(`detached ${this.opts.socketPath}`);
      // Reject pending requests so callers don't hang.
      for (const [, p] of this.pending) {
        p.reject(new Error("socket closed"));
      }
      this.pending.clear();
      this.emit("close", { hadError });
    });
  }

  stop(): void {
    if (this.sock && !this.sock.destroyed) {
      this.sock.end();
      this.sock.destroy();
    }
  }

  // Send a JSON-RPC request and await the response.
  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error) {
            reject(
              new Error(
                `${resp.error.code}: ${resp.error.message}`,
              ),
            );
          } else {
            resolve(resp.result as R);
          }
        },
        reject,
      });
    });
  }

  // Send a notification (no id, no response).
  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
  }

  // Reply to a request that came from the agent (e.g., an fs/ request).
  reply(id: JsonRpcId, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.write(msg);
  }

  replyError(id: JsonRpcId, code: number, message: string): void {
    const msg: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    this.write(msg);
  }

  private write(msg: JsonRpcMessage): void {
    if (!this.sock || this.sock.destroyed) {
      log.warn(`drop write to closed socket: ${JSON.stringify(msg)}`);
      return;
    }
    this.sock.write(`${JSON.stringify(msg)}\n`);
  }

  private onMessage(m: JsonRpcMessage): void {
    if (isResponse(m)) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        p.resolve(m);
      } else {
        // Response to something we didn't send — could be an old replay.
        log.debug(`unmatched response id=${String(m.id)}`);
      }
      this.emit("response", m);
    } else if (isRequest(m)) {
      this.emit("request", m);
    } else if (isNotification(m)) {
      this.emit("notification", m);
    }
  }
}
