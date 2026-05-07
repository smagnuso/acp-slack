import { strict as assert } from "node:assert";
import { test } from "node:test";
import { reactionAction } from "../src/slack/reaction-map.js";

test("maps allow-once reactions", () => {
  for (const r of ["white_check_mark", "+1", "star"]) {
    assert.equal(reactionAction(r), "allow");
  }
});

test("maps allow-always reaction", () => {
  assert.equal(reactionAction("unlock"), "allow_always");
});

test("maps deny reactions", () => {
  for (const r of ["x", "-1"]) {
    assert.equal(reactionAction(r), "deny");
  }
});

test("maps cancel reactions", () => {
  for (const r of ["stop_sign", "octagonal_sign", "no_entry", "no_entry_sign", "stop"]) {
    assert.equal(reactionAction(r), "cancel");
  }
});

test("maps hide and expand reactions", () => {
  assert.equal(reactionAction("see_no_evil"), "hide");
  assert.equal(reactionAction("no_bell"), "hide");
  assert.equal(reactionAction("eyes"), "expand_truncated");
  assert.equal(reactionAction("book"), "expand_full");
  assert.equal(reactionAction("open_book"), "expand_full");
});

test("returns undefined for unknown reactions", () => {
  assert.equal(reactionAction("rocket"), undefined);
  assert.equal(reactionAction("fire"), undefined);
});
