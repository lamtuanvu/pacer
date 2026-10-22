import { expect, test } from "bun:test";
import { terminalDocument } from "../app/src/term/document";
import { nativeTerminalEnv } from "../src/session/environment";

test("only the terminal document stamps generated style elements, leaving the real document unchanged", () => {
  const doc = {createElement(tag: string) {return {tag, nonce: ""};}, marker: "original"};
  const terminal = terminalDocument(doc as unknown as Document, "page-nonce");
  expect(terminal.createElement("style").nonce).toBe("page-nonce");
  expect(terminal.createElement("div").nonce).toBe("");
  expect(doc.createElement("style").nonce).toBe("");
});
test("interactive agents get a truecolor TTY rather than automation color suppression", () => {
  const base = {NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", KEEP: "yes"};
  expect(nativeTerminalEnv(base)).toEqual({TERM: "xterm-256color", COLORTERM: "truecolor", KEEP: "yes"});
  expect(base.NO_COLOR).toBe("1");
});
