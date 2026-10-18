import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderProtocolDoc } from "../scripts/protocol-doc";
import { helloBody } from "../src/api/protocol";
import { opNames } from "../src/api/ops";

test("docs/protocol.md is generated from the registry and up to date: run `bun run protocol:doc`", () => {
  const doc = renderProtocolDoc();
  for (const name of opNames()) expect(doc).toContain(`### \`${name}\``);
  expect(doc).toContain("2.9.0");
  expect(readFileSync(join(import.meta.dir, "..", "docs", "protocol.md"), "utf8")).toBe(doc);
});

test("2.2+ hello advertises attention, activity and repository operations", () => {
  const hello = helloBody();
  expect(hello.protocol).toBe("2.9.0");
  for (const op of ["attention.dismiss", "attention.snooze", "task.retry_options", "activity.list", "repo.list", "repo.add", "repo.remove"]) expect(hello.ops).toContain(op);
  for (const text of ["ui.open", "expect_rev", "POST /v2/session/exchange", "## Activity", "## Attention and actions"]) expect(renderProtocolDoc()).toContain(text);
});
