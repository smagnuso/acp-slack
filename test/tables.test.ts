import { strict as assert } from "node:assert";
import { test } from "node:test";
import { convertMarkdownTables } from "../src/formatters/tables.js";

test("converts a simple GFM table to a code-fenced aligned block", () => {
  const input = [
    "| name | role |",
    "|------|------|",
    "| ada  | engineer |",
    "| bob  | pm |",
  ].join("\n");
  const out = convertMarkdownTables(input);
  assert.match(out, /^```\n/);
  assert.match(out, /\n```$/);
  // Pipe syntax preserved, columns padded to the widest cell.
  assert.match(out, /\| name \| role {5}\|/); // role padded to "engineer" (8 chars)
  assert.match(out, /\| ada {2}\| engineer \|/);
  assert.match(out, /\| bob {2}\| pm {7}\|/);
  // Separator dashes match column width + surrounding spaces.
  assert.match(out, /\|------\|----------\|/);
});

test("leaves text without tables unchanged", () => {
  const input = "hello world\n\nanother line\n";
  assert.equal(convertMarkdownTables(input), input);
});

test("does not transform tables inside fenced code", () => {
  const input = [
    "outside",
    "```",
    "| name | role |",
    "|------|------|",
    "| ada  | eng |",
    "```",
    "after",
  ].join("\n");
  // The inner table should stay literal; output should match input.
  assert.equal(convertMarkdownTables(input), input);
});
