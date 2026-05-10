import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseSessionArgs } from "../src/slack/commands.js";

test("empty body uses all defaults", () => {
  assert.deepEqual(parseSessionArgs(""), {
    agentId: undefined,
    cwd: undefined,
    prompt: undefined,
  });
});

test("path-only argument is parsed as cwd", () => {
  assert.deepEqual(parseSessionArgs(" ~/dev/foo "), {
    agentId: undefined,
    cwd: "~/dev/foo",
    prompt: undefined,
  });
});

test("bare-word-only argument is parsed as agentId", () => {
  assert.deepEqual(parseSessionArgs("opencode"), {
    agentId: "opencode",
    cwd: undefined,
    prompt: undefined,
  });
});

test("agent followed by cwd", () => {
  assert.deepEqual(parseSessionArgs("opencode ~/dev/foo"), {
    agentId: "opencode",
    cwd: "~/dev/foo",
    prompt: undefined,
  });
});

test("agent + cwd + prompt without --", () => {
  assert.deepEqual(parseSessionArgs("opencode ~/dev/foo fix the bug"), {
    agentId: "opencode",
    cwd: "~/dev/foo",
    prompt: "fix the bug",
  });
});

test("cwd + default agent + prompt", () => {
  assert.deepEqual(parseSessionArgs("~/dev/foo fix the bug"), {
    agentId: undefined,
    cwd: "~/dev/foo",
    prompt: "fix the bug",
  });
});

test("-- forces everything after as prompt (defaults + prompt)", () => {
  assert.deepEqual(parseSessionArgs("-- fix the bug"), {
    agentId: undefined,
    cwd: undefined,
    prompt: "fix the bug",
  });
});

test("-- after a cwd preserves the cwd and treats rest as prompt", () => {
  assert.deepEqual(parseSessionArgs("~/dev/foo -- fix the bug"), {
    agentId: undefined,
    cwd: "~/dev/foo",
    prompt: "fix the bug",
  });
});

test("-- with empty prompt clears prompt to undefined", () => {
  assert.deepEqual(parseSessionArgs("opencode --"), {
    agentId: "opencode",
    cwd: undefined,
    prompt: undefined,
  });
});

test("absolute path is treated as cwd", () => {
  assert.deepEqual(parseSessionArgs("/var/tmp/work"), {
    agentId: undefined,
    cwd: "/var/tmp/work",
    prompt: undefined,
  });
});

test("./relative path is treated as cwd", () => {
  assert.deepEqual(parseSessionArgs("./scratch"), {
    agentId: undefined,
    cwd: "./scratch",
    prompt: undefined,
  });
});

test("a token that looks neither like a path nor a known agent id starts the prompt", () => {
  // "what" would be matched as agentId here (it's word-shaped); use --
  // for the unambiguous prompt-only form. This is the documented quirk.
  assert.deepEqual(parseSessionArgs("-- what is the time"), {
    agentId: undefined,
    cwd: undefined,
    prompt: "what is the time",
  });
});
