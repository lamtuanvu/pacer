import { expect, test } from "bun:test";
import { evalCondition, parseCondition, type CondAst } from "../src/workflow/condition";

const ev = (s: string, result: unknown = {}) => evalCondition(parseCondition(s).ast!, { result, brief: "b" });

test("comparisons and logic", () => {
  expect(ev("result.verdict == 'pass'", { verdict: "pass" })).toBe(true);
  expect(ev("result.verdict == 'pass'", { verdict: "fail" })).toBe(false);
  expect(ev("result.n >= 2 and not result.blocked", { n: 3, blocked: false })).toBe(true);
  expect(ev("result.n >= 2 and not result.blocked", { n: 1, blocked: false })).toBe(false);
  expect(ev("result.n >= 2 and not result.blocked", { n: 3, blocked: true })).toBe(false);
  expect(ev("result.route in ['a', 'b']", { route: "b" })).toBe(true);
  expect(ev("result.route in ['a', 'b']", { route: "c" })).toBe(false);
  expect(ev("result.route != 'c'", { route: "b" })).toBe(true);
  expect(ev("result.name < 'zulu'", { name: "alpha" })).toBe(true);
  expect(ev("result.name < 'zulu'", { name: "zulu" })).toBe(false);
  expect(ev("true")).toBe(true);
  expect(ev("false")).toBe(false);
  expect(ev("not false")).toBe(true);
  expect(ev("result.a or result.b", { a: false, b: "yes" })).toBe(true);
  expect(ev("not (result.a and result.b)", { a: true, b: false })).toBe(true);
});

test("bare values are truthy-tested", () => {
  expect(ev("result.verdict", { verdict: "pass" })).toBe(true);
  expect(ev("result.verdict", { verdict: "" })).toBe(false);
  expect(ev("result.n", { n: 0 })).toBe(false);
  expect(ev("result.n", { n: 2 })).toBe(true);
  expect(ev("result.flag", { flag: false })).toBe(false);
});

test("missing fields and type mismatches are false, never throw", () => {
  expect(ev("result.verdict == 'pass'", {})).toBe(false);
  expect(ev("result.verdict != 'pass'", {})).toBe(false);
  expect(ev("result.n > 2", { n: "three" })).toBe(false);
  expect(ev("result.n > 2", { n: "3" })).toBe(false);
  expect(ev("result.a.b.c", null)).toBe(false);
  expect(ev("result.a.b.c", undefined)).toBe(false);
  expect(ev("result.a.b.c", {})).toBe(false);
  expect(ev("result.a.b.c", { a: 1 })).toBe(false);
  expect(ev("result.route in 'ab'", { route: "a" })).toBe(false);
  expect(ev("result.route in ['a', 'b']", {})).toBe(false);
  expect(ev("brief == 'b'", {})).toBe(true);
  expect(parseCondition("result.list[0] == 'a'").error).toMatch(/unexpected '\['/); // [ ] indexing is not in the grammar
});

test("condition paths walk own properties only", () => {
  expect(ev("result.constructor", {})).toBe(false); // prototype keys never resolve
  expect(ev("result.constructor == 'x'", {})).toBe(false);
  expect(ev("result.verdict == 'pass'", { verdict: "pass" })).toBe(true);
  expect(ev("result.route in ['a']", { route: "a" })).toBe(true);
});

test("parse errors name the position", () => {
  expect(parseCondition("result.x ==").error).toMatch(/position 11/);
  expect(parseCondition("result.x ==").ast).toBeUndefined();
  expect(parseCondition("result.x == ")).toMatchObject({ error: expect.stringMatching(/position 12/) });
  expect(parseCondition("result.x == 'a")).toMatchObject({ error: expect.stringMatching(/unterminated string at position 12/) });
  expect(parseCondition("result.x & 'a'").error).toMatch(/unexpected character '&' at position 9/);
  expect(parseCondition("foo.bar").error).toMatch(/unknown path root 'foo' at position 0/);
  expect(parseCondition("result.x == 'a' 1").error).toMatch(/unexpected '1' at position 16/);
  expect(parseCondition("(result.x").error).toMatch(/expected '\)' at position 9/);
  expect(parseCondition("").error).toBeTruthy();
});

test("the ast distinguishes or, and, not, cmp and truthy nodes", () => {
  const ast: CondAst = parseCondition("result.a or result.b == 1 and not result.c").ast!;
  expect(ast.kind).toBe("or");
  if (ast.kind !== "or") throw new Error("expected an or node");
  expect(ast.terms).toHaveLength(2);
  expect(ast.terms[0]).toEqual({ kind: "truthy", value: { kind: "path", segments: ["result", "a"] } });
  expect(ast.terms[1].kind).toBe("and");
  expect(parseCondition("result.x").ast!.kind).toBe("truthy");
  expect(parseCondition("result.x == 1").ast!.kind).toBe("cmp");
  expect(parseCondition("not result.x").ast!.kind).toBe("not");
});
