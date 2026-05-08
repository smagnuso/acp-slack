// Convert markdown tables in a string into aligned, code-fenced tables.
// Slack's mrkdwn doesn't render markdown tables; the convention from
// agent-shell-to-go is to convert them to fixed-width plain text inside a
// ```sh block so they at least line up in monospace.

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const SEPARATOR_LINE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const FENCE_LINE = /^\s*```/;

export function convertMarkdownTables(text: string): string {
  if (!text.includes("|")) {
    return text;
  }
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (
      !inFence &&
      TABLE_LINE.test(line) &&
      i + 1 < lines.length &&
      SEPARATOR_LINE.test(lines[i + 1] ?? "")
    ) {
      // Collect contiguous table rows.
      const rows: string[] = [];
      while (i < lines.length && TABLE_LINE.test(lines[i] ?? "")) {
        rows.push(lines[i] ?? "");
        i++;
      }
      out.push(formatTable(rows));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

function parseRow(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) {
    inner = inner.slice(1);
  }
  if (inner.endsWith("|")) {
    inner = inner.slice(0, -1);
  }
  return inner.split("|").map((c) => c.trim());
}

function formatTable(rawRows: string[]): string {
  // First row = header, second = separator (skip), rest = data. Preserve
  // GFM `|` syntax, just pad each cell to the column max so the table
  // lines up in monospace inside the fence. Keeping `|` reads more like
  // a familiar markdown table than the previous ─-only style and is
  // easier to copy back out as raw markdown.
  const header = parseRow(rawRows[0] ?? "");
  const data = rawRows.slice(2).map(parseRow);
  const all: string[][] = [header, ...data];
  const cols = Math.max(...all.map((r) => r.length));
  const widths = new Array<number>(cols).fill(0);
  for (const row of all) {
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? "";
      if (cell.length > (widths[c] ?? 0)) {
        widths[c] = cell.length;
      }
    }
  }
  const padCell = (cell: string, w: number): string =>
    cell + " ".repeat(Math.max(0, w - cell.length));
  const renderRow = (row: string[]): string =>
    "| " +
    row.map((cell, c) => padCell(cell ?? "", widths[c] ?? 0)).join(" | ") +
    " |";
  // Separator: |---|---|… with each segment matching column width + the
  // surrounding " ... " padding.
  const sep =
    "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  const lines: string[] = ["```", renderRow(header), sep];
  for (const row of data) {
    lines.push(renderRow(row));
  }
  lines.push("```");
  return lines.join("\n");
}
