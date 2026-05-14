import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findSplitPoint } from "../src/acp/session.js";

test("findSplitPoint prefers a paragraph break before the limit", () => {
  const text = "first paragraph here\n\nsecond paragraph continues on";
  const at = findSplitPoint(text, 40);
  assert.equal(at, 22);
  assert.equal(text.slice(0, at), "first paragraph here\n\n");
});

test("findSplitPoint falls back to a single newline when no paragraph break is in window", () => {
  const text = "line one is fairly long\nline two";
  const at = findSplitPoint(text, 28);
  assert.equal(at, 24);
  assert.equal(text.slice(0, at), "line one is fairly long\n");
});

test("findSplitPoint falls back to a sentence boundary when no newlines exist", () => {
  const text = "first sentence here. second sentence runs on and on";
  const at = findSplitPoint(text, 40);
  assert.equal(at, 21);
  assert.equal(text.slice(0, at), "first sentence here. ");
});

test("findSplitPoint hard-caps at limit when no safe split exists", () => {
  const text = "a".repeat(50);
  assert.equal(findSplitPoint(text, 20), 20);
});

test("findSplitPoint rejects splits that land in the first half of the window", () => {
  // Single newline 5 chars in, then a long run with no other splits — we
  // don't want to leave just 5 chars in the head message, so hard-cap.
  const text = "x\n" + "y".repeat(60);
  assert.equal(findSplitPoint(text, 40), 40);
});

test("findSplitPoint picks the latest paragraph break in window", () => {
  const text = "para one\n\npara two\n\npara three continues with more text";
  const at = findSplitPoint(text, 40);
  assert.equal(text.slice(0, at), "para one\n\npara two\n\n");
});
