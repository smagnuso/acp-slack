import { convertMarkdownTables } from "./tables.js";

// Best-effort markdown → Slack mrkdwn. Slack's flavor:
//   *bold*, _italic_, ~strike~, `code`, ```fence```, > quote, * bullets.
// Standard markdown uses **bold** and __bold__, *italic* / _italic_, etc.
// This is intentionally light — agents emit GFM-ish text and the goal is
// "looks reasonable in Slack", not full fidelity.
//
// We deliberately avoid touching content inside fenced code blocks.
export function toSlackMrkdwn(text: string): string {
  const withTables = convertMarkdownTables(text);
  return transformOutsideFences(withTables, transform);
}

function transform(s: string): string {
  // **bold** -> *bold*  (and __bold__ -> *bold*)
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
  s = s.replace(/__([^_\n]+?)__/g, "*$1*");
  // [text](url) -> <url|text>
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // # heading -> *heading*
  s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_m, _hashes: string, body: string) => `*${body.trim()}*`);
  return s;
}

function transformOutsideFences(text: string, fn: (s: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((p) => (p.startsWith("```") ? p : fn(p)))
    .join("");
}
