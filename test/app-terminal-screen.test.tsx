import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TerminalView } from "../app/src/term/term";

test("general shell mode names the input target and avoids agent-only copy", () => {
  const html = renderToString(<TerminalView id="shell-one" shell control />);
  expect(html).toContain("Connecting…");
  expect(html).not.toContain("Search terminal output");
  expect(html).not.toContain("Only one window can type");
  expect(html).not.toContain("Only for agents running interactively");
});
