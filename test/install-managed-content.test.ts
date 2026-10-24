import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { PACER } from "./install-helpers";
import { runInstall } from "../src/install/txn";
import { managedContent } from "../src/install/managed-content";

test("installer stages files until every edit is planned and detects external edits", async () => {
  const ctx = fakeCtx(), path = join(ctx.home, "AGENTS.md");
  writeFileSync(path, "before");
  await expect(runInstall({ ctx, pacerArgv: PACER }, "codex", tx => {
    tx.edit(path, () => "after", []);
    expect(readFileSync(path, "utf8")).toBe("before");
    writeFileSync(path, "external");
  })).rejects.toThrow("changed");
  expect(readFileSync(path, "utf8")).toBe("external");
});

test("owned hook projection preserves unrelated edits but detects a changed timeout", () => {
  const ops = [{ kind: "hooks" as const, format: "claude" as const, commands: ["pacer guard --planner codex"], restore: [] }];
  const text = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "spawn_agent", hooks: [{ command: ops[0].commands[0], timeout: 15 }] }] } });
  expect(managedContent(text, ops)).toBe(managedContent(text.replace('{"hooks"', '{"theme":"dark","hooks"'), ops));
  expect(managedContent(text, ops)).not.toBe(managedContent(text.replace('"timeout":15', '"timeout":30'), ops));
});

test("ambiguous or unbalanced managed blocks are rejected", () => {
  const block = '<!-- >>> pacer >>> -->\nhello\n<!-- <<< pacer <<< -->\n';
  expect(() => managedContent(block + block, [{ kind: "block", style: "md" }])).toThrow();
  expect(() => managedContent('<!-- >>> pacer >>> -->', [{ kind: "block", style: "md" }])).toThrow();
});
