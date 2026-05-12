import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseHydraHistory,
  renderHydraHistoryAsMarkdown,
  type HydraHistoryEntry,
} from "../src/acp/hydra-history.js";

test("parseHydraHistory: parses well-formed NDJSON", () => {
  const raw =
    JSON.stringify({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
      recordedAt: 1,
    }) +
    "\n" +
    JSON.stringify({
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "turn_complete" } },
      recordedAt: 2,
    }) +
    "\n";
  const out = parseHydraHistory(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.recordedAt, 1);
  assert.equal(out[1]?.recordedAt, 2);
});

test("parseHydraHistory: skips empty lines and malformed entries", () => {
  const raw = [
    "",
    "not json",
    JSON.stringify({ method: "session/update", recordedAt: 5, params: {} }),
    JSON.stringify({ method: "session/update" }), // missing recordedAt
    JSON.stringify({ recordedAt: 7, params: {} }), // missing method
    "",
  ].join("\n");
  const out = parseHydraHistory(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.recordedAt, 5);
});

function entry(
  recordedAt: number,
  update: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): HydraHistoryEntry {
  return {
    method: "session/update",
    params: { sessionId: "s", update, ...extra },
    recordedAt,
  };
}

test("renderHydraHistoryAsMarkdown: prompt + agent + turn boundary", () => {
  const entries: HydraHistoryEntry[] = [
    entry(1000, {
      sessionUpdate: "prompt_received",
      prompt: [{ type: "text", text: "do the thing" }],
    }),
    entry(1500, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "doing " },
    }),
    entry(1600, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "the thing." },
    }),
    entry(1700, { sessionUpdate: "turn_complete", stopReason: "end_turn" }),
  ];
  const md = renderHydraHistoryAsMarkdown({
    sessionId: "hydra_session_abc",
    title: "fix bug",
    cwd: "/home/me/proj",
    entries,
  });
  assert.match(md, /# fix bug/);
  assert.match(md, /\*\*Session:\*\* `hydra_session_abc`/);
  assert.match(md, /\*\*Cwd:\*\* `\/home\/me\/proj`/);
  assert.match(md, /## User — /);
  assert.match(md, /do the thing/);
  assert.match(md, /## Agent — /);
  assert.match(md, /doing the thing\./);
});

test("renderHydraHistoryAsMarkdown: coalesces agent chunks across many entries", () => {
  const entries: HydraHistoryEntry[] = Array.from({ length: 5 }, (_, i) =>
    entry(1000 + i, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `chunk${i}` },
    }),
  );
  const md = renderHydraHistoryAsMarkdown({
    sessionId: "s",
    entries,
  });
  // All five chunks should end up in a single agent block.
  const agentBlocks = md.match(/## Agent —/g) ?? [];
  assert.equal(agentBlocks.length, 1);
  assert.match(md, /chunk0chunk1chunk2chunk3chunk4/);
});

test("renderHydraHistoryAsMarkdown: collapses tool_call + updates to last status", () => {
  const entries: HydraHistoryEntry[] = [
    entry(1, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Read foo.ts",
      status: "pending",
    }),
    entry(2, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    }),
    entry(3, { sessionUpdate: "turn_complete" }),
  ];
  const md = renderHydraHistoryAsMarkdown({ sessionId: "s", entries });
  assert.match(md, /### Tools/);
  assert.match(md, /`Read foo\.ts` — completed/);
  // No 'pending' status should appear in the rendered tools block.
  assert.equal(md.includes("`Read foo.ts` — pending"), false);
});

test("renderHydraHistoryAsMarkdown: renders plan with checkboxes", () => {
  const entries: HydraHistoryEntry[] = [
    entry(1, {
      sessionUpdate: "plan",
      entries: [
        { content: "step 1", status: "completed" },
        { content: "step 2", status: "in_progress" },
        { content: "step 3", status: "pending" },
      ],
    }),
    entry(2, { sessionUpdate: "turn_complete" }),
  ];
  const md = renderHydraHistoryAsMarkdown({ sessionId: "s", entries });
  assert.match(md, /### Plan/);
  assert.match(md, /- \[x\] step 1/);
  assert.match(md, /- \[~\] step 2/);
  assert.match(md, /- \[ \] step 3/);
});

test("renderHydraHistoryAsMarkdown: drops compat user_message_chunk", () => {
  const entries: HydraHistoryEntry[] = [
    entry(1, {
      sessionUpdate: "prompt_received",
      prompt: [{ type: "text", text: "real prompt" }],
    }),
    entry(2, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "real prompt" },
      _meta: { "hydra-acp": { compatFor: "prompt_received" } },
    }),
    entry(3, { sessionUpdate: "turn_complete" }),
  ];
  const md = renderHydraHistoryAsMarkdown({ sessionId: "s", entries });
  // Exactly one User block — the compat duplicate should be skipped.
  const userBlocks = md.match(/## User —/g) ?? [];
  assert.equal(userBlocks.length, 1);
});

test("renderHydraHistoryAsMarkdown: includes model + mode in header when provided", () => {
  const md = renderHydraHistoryAsMarkdown({
    sessionId: "s",
    currentModel: "sonnet-4.6",
    currentMode: "plan",
    entries: [],
  });
  assert.match(md, /\*\*Model:\*\* `sonnet-4\.6`/);
  assert.match(md, /\*\*Mode:\*\* `plan`/);
});

test("renderHydraHistoryAsMarkdown: empty entries renders a placeholder body", () => {
  const md = renderHydraHistoryAsMarkdown({ sessionId: "s", entries: [] });
  assert.match(md, /_\(no conversation content\)_/);
});

test("renderHydraHistoryAsMarkdown: non-end_turn stopReason appears as a note", () => {
  const entries: HydraHistoryEntry[] = [
    entry(1, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "halt" },
    }),
    entry(2, { sessionUpdate: "turn_complete", stopReason: "cancelled" }),
  ];
  const md = renderHydraHistoryAsMarkdown({ sessionId: "s", entries });
  assert.match(md, /_turn ended: cancelled_/);
});
