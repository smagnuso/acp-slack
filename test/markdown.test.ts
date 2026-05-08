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

test("wraps ascii-art tables (─ separator) in a code fence", () => {
  const src = [
    "leading prose",
    "",
    "  #   File           Currently   Should be",
    "  ─   ────────────   ─────────   ─────────",
    "  1   GPUTexture.h   send        sendNoncancelable",
    "  2   GibbonPlat.cpp send        sendCancelable",
    "",
    "trailing prose",
  ].join("\n");
  const out = toSlackMrkdwn(src);
  // The block containing the ─ separator should now be wrapped in a fence.
  assert.match(out, /```\n  #   File/);
  assert.match(out, /sendCancelable\n```/);
  // Surrounding prose stays outside fences.
  assert.match(out, /leading prose/);
  assert.match(out, /trailing prose/);
});

test("does not touch ascii-art tables already inside a fence", () => {
  const src = "```\n  ─   ────\n  1   x\n```";
  // Already fenced — wrapAsciiTables runs only outside existing fences,
  // so we shouldn't see double-wrapping.
  const out = toSlackMrkdwn(src);
  // No double opening fence on its own line.
  assert.equal(out.match(/^```$/gm)?.length, 2);
});
