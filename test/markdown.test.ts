import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toSlackMrkdwn } from "../src/formatters/markdown.js";

test("converts **bold** and __bold__ to *bold*", () => {
  assert.equal(toSlackMrkdwn("**hi** there"), "*hi* there");
  assert.equal(toSlackMrkdwn("__yo__"), "*yo*");
});

test("converts links", () => {
  assert.equal(toSlackMrkdwn("[ex](https://e.com)"), "<https://e.com|ex>");
});

test("converts headings", () => {
  assert.equal(toSlackMrkdwn("# Title\nbody"), "*Title*\nbody");
  assert.equal(toSlackMrkdwn("### sub"), "*sub*");
});

test("preserves fenced code untouched", () => {
  const src = "before\n```\n**not bold** [link](u)\n```\nafter";
  const out = toSlackMrkdwn(src);
  assert.match(out, /```\n\*\*not bold\*\* \[link\]\(u\)\n```/);
});
