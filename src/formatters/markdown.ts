import { convertMarkdownTables } from "./tables.js";

// Best-effort markdown → Slack mrkdwn. Slack's flavor:
//   *bold*, _italic_, ~strike~, `code`, ```fence```, > quote, * bullets.
// Standard markdown uses **bold** and __bold__, *italic* / _italic_, etc.
// This is intentionally light — agents emit GFM-ish text and the goal is
// "looks reasonable in Slack", not full fidelity.
//
// We deliberately avoid touching content inside fenced code blocks.
export function toSlackMrkdwn(text: string): string {
  const withGfmTables = convertMarkdownTables(text);
  const withAsciiTables = transformOutsideFences(withGfmTables, wrapAsciiTables);
  return transformOutsideFences(withAsciiTables, transform);
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

// Detect ASCII-art tables that the agent rendered with box-drawing chars
// (─ runs as a separator, no `|` columns) and wrap them in a code fence
// so Slack renders them monospace and column-aligned. Without this,
// Slack's variable-width rendering shreds the alignment.
//
// A "separator line" is one whose non-whitespace content is entirely ─
// characters. We expand outward from each separator to the nearest
// blank lines on either side and wrap that block in ```. Slightly
// over-aggressive — a paragraph ending right above a divider would get
// wrapped too — but rare in practice and the alignment win on real
// tables is worth the occasional overshoot.
function wrapAsciiTables(text: string): string {
  const lines = text.split("\n");
  if (!lines.some(isHorizontalBarLine)) {
    return text;
  }
  const wrap = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!isHorizontalBarLine(lines[i] ?? "")) {
      continue;
    }
    let start = i;
    while (start > 0 && (lines[start - 1] ?? "").trim() !== "") {
      start--;
    }
    let end = i;
    while (end < lines.length - 1 && (lines[end + 1] ?? "").trim() !== "") {
      end++;
    }
    for (let j = start; j <= end; j++) {
      wrap[j] = true;
    }
  }
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (wrap[i] && !fenced) {
      out.push("```");
      fenced = true;
    } else if (!wrap[i] && fenced) {
      out.push("```");
      fenced = false;
    }
    out.push(lines[i] ?? "");
  }
  if (fenced) {
    out.push("```");
  }
  return out.join("\n");
}

function isHorizontalBarLine(line: string): boolean {
  if (!line.includes("─")) {
    return false;
  }
  // Line consists only of ─ characters and whitespace, with at least
  // one run of 3+ ─ — filters out incidental single bars in prose.
  return /^[\s─]+$/.test(line) && /─{3,}/.test(line);
}

function transformOutsideFences(text: string, fn: (s: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts
    .map((p) => (p.startsWith("```") ? p : fn(p)))
    .join("");
}
