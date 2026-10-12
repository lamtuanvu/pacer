import { expect, test } from "bun:test";
import { JsoncError, stripJsonc, parseJsonc, getMember, isEmptyObject, setMember, removeMember } from "../src/install/jsonc";

const OPENCODE = `{
  // user comment
  "mcp": {
    "other": {"type": "local", "command": ["other",],},
  },
  "theme": "dark", /* trailing */
}
`;
const PACER = { type: "local", command: ["pacer", "mcp"], enabled: true };

test("JSONC parses comments and trailing commas while preserving comment-like strings", () => {
  expect(parseJsonc(OPENCODE)).toEqual({ mcp: { other: { type: "local", command: ["other"] } }, theme: "dark" });
  const literal = '{"a": "// not a comment, ]"}';
  expect(stripJsonc(literal)).toBe(literal);
  expect(parseJsonc('{"a": "escaped \\\" /* string */", "b": [true, false, null, -1.25e+2,],}')).toEqual({ a: 'escaped " /* string */', b: [true, false, null, -125] });
});

test("JSONC rejects invalid syntax and non-object roots", () => {
  expect(() => parseJsonc("{ nope }")).toThrow(JsoncError);
  expect(() => parseJsonc("[1]")).toThrow("top level must be an object");
  for (const text of ['{"a": 01}', '{"a": 1} false', '{"a": "unterminated}', '{/* unterminated', '{"a": [1,,]}']) {
    expect(() => parseJsonc(text)).toThrow(JsoncError);
  }
});

test("all editor entry points reject whitespace outside JSON syntax", () => {
  const invalid = '{\u00a0"a": 1}';
  expect(() => getMember(invalid, ["a"])).toThrow(JsoncError);
  expect(() => isEmptyObject(invalid, [])).toThrow(JsoncError);
  expect(() => setMember(invalid, ["b"], 2)).toThrow(JsoncError);
  expect(() => removeMember(invalid, ["a"])).toThrow(JsoncError);
});

test("inserting mcp.pacer preserves comments, indentation, and exact removal", () => {
  const installed = setMember(OPENCODE, ["mcp", "pacer"], PACER);
  expect(installed).toContain('// user comment');
  expect(installed).toContain('/* trailing */');
  expect(installed).toContain('    "pacer": {\n      "type": "local",');
  expect(getMember(installed, ["mcp", "pacer"])).toEqual(PACER);
  expect(removeMember(installed, ["mcp", "pacer"])).toBe(OPENCODE);
});

test("replacing an existing value changes only its span", () => {
  const original = '{\n  "a": 1 /* keep */,\n  "b": 2\n}\n';
  expect(setMember(original, ["a"], { nested: true })).toBe('{\n  "a": {\n    "nested": true\n  } /* keep */,\n  "b": 2\n}\n');
});

test("missing parents are created and removed without changing bare text", () => {
  const bare = '{\n  "theme": "dark"\n}\n';
  const installed = setMember(bare, ["mcp", "pacer"], PACER);
  expect(getMember(installed, ["mcp", "pacer"])).toEqual(PACER);
  const removed = removeMember(installed, ["mcp", "pacer"]);
  expect(isEmptyObject(removed, ["mcp"])).toBe(true);
  expect(removeMember(removed, ["mcp"])).toBe(bare);
});

test("empty object insertion is valid and removal restores braces", () => {
  expect(setMember("{}", ["a"], 1)).toBe('{\n  "a": 1\n}');
  expect(removeMember(setMember("{}", ["a"], 1), ["a"])).toBe("{}");
});

test("inline Cursor formatting inserts and removes exactly", () => {
  const cursor = '{ "mcpServers": { "GitKraken": {\n\t"command": "gk"\n} } }\n';
  const installed = setMember(cursor, ["mcpServers", "pacer"], { command: "pacer", args: ["mcp"] });
  expect(getMember(installed, ["mcpServers", "GitKraken", "command"])).toBe("gk");
  expect(removeMember(installed, ["mcpServers", "pacer"])).toBe(cursor);
});

test("member lookup and missing removal preserve the document", () => {
  expect(getMember(OPENCODE, [])).toEqual(parseJsonc(OPENCODE));
  expect(getMember(OPENCODE, ["missing", "child"])).toBeUndefined();
  expect(getMember(OPENCODE, ["theme", "child"])).toBeUndefined();
  expect(isEmptyObject(OPENCODE, ["missing"])).toBe(false);
  expect(isEmptyObject(OPENCODE, ["theme"])).toBe(false);
  expect(removeMember(OPENCODE, ["missing"])).toBe(OPENCODE);
});

test("non-object parents reject insertion", () => {
  for (const parent of [null, [], "value", 1]) {
    expect(() => setMember(JSON.stringify({ mcp: parent }), ["mcp", "pacer"], PACER)).toThrow(JsoncError);
  }
});

test("last member removal and trailing comma removal leave valid objects", () => {
  expect(removeMember('{"a": 1, "b": 2}', ["b"])).toBe('{"a": 1}');
  expect(removeMember('{"a": 1, "b": 2,}', ["b"])).toBe('{"a": 1, }');
  expect(removeMember('{ /* comment */ "a": 1, }', ["a"])).toBe('{}');
});

test("escaped keys and tab indentation are handled", () => {
  const text = '{\n\t"a\\\"b": {},\n\t"other": true\n}';
  expect(getMember(setMember(text, ['a"b', '__proto__', 'x'], 2), ['a"b', '__proto__', 'x'])).toBe(2);
  const installed = setMember(text, ["pacer"], { enabled: true });
  expect(installed).toContain('\n\t"pacer": {\n\t  "enabled": true');
  expect(removeMember(installed, ["pacer"])).toBe(text);
});
