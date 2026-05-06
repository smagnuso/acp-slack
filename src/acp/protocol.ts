// Subset of ACP types we care about. The wire format is JSON-RPC 2.0 over
// ndjson; we don't try to model every field, just what we route on.

export type JsonRpcId = number | string;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !("method" in m) && "id" in m;
}

// --- ACP-specific shapes (best-effort, partial) --------------------------

export interface InitializeParams {
  protocolVersion?: number;
  clientCapabilities?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
}

export interface SessionId {
  sessionId: string;
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: {
    sessionUpdate: string;
    [key: string]: unknown;
  };
}

export interface PermissionRequestParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    [key: string]: unknown;
  };
  options: Array<{
    optionId: string;
    name: string;
    kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
}

export interface PermissionResponseResult {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

export interface FsReadParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface FsWriteParams {
  sessionId: string;
  path: string;
  content: string;
}
