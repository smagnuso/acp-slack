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
  // Check both rows end up aligned with the same pad widths.
  assert.match(out, /name {0,4}   role/);
  assert.match(out, /ada  {0,4}   engineer/);
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
