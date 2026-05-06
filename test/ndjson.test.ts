import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NdjsonParser } from "../src/util/ndjson.js";

test("splits complete lines", () => {
  const out: unknown[] = [];
  const errs: Array<[Error, string]> = [];
  const p = new NdjsonParser(
    (m) => out.push(m),
    (e, raw) => errs.push([e, raw]),
  );
  p.push('{"a":1}\n{"b":2}\n');
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  assert.equal(errs.length, 0);
});

test("buffers partial lines across chunks", () => {
  const out: unknown[] = [];
  const p = new NdjsonParser(
    (m) => out.push(m),
    () => undefined,
  );
  p.push('{"a":1}\n{"b":');
  assert.deepEqual(out, [{ a: 1 }]);
  p.push("2}\n");
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test("flush emits trailing line without newline", () => {
  const out: unknown[] = [];
  const p = new NdjsonParser(
    (m) => out.push(m),
    () => undefined,
  );
  p.push('{"a":1}');
  assert.deepEqual(out, []);
  p.flush();
  assert.deepEqual(out, [{ a: 1 }]);
});

test("calls onError for malformed lines but continues", () => {
  const out: unknown[] = [];
  const errs: Array<[Error, string]> = [];
  const p = new NdjsonParser(
    (m) => out.push(m),
    (e, raw) => errs.push([e, raw]),
  );
  p.push("not-json\n{\"ok\":true}\n");
  assert.equal(errs.length, 1);
  assert.equal(errs[0]?.[1], "not-json");
  assert.deepEqual(out, [{ ok: true }]);
});
