import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { EXTRA_COMMANDS, findCommand } from "../src/commands/index";
import type { Command } from "../src/commands/types";
import { validateStrategy } from "../src/config/strategy";
import { fakeCtx } from "./helpers";

const added: Command[] = [];
afterEach(() => {
  for (const c of added.splice(0)) EXTRA_COMMANDS.splice(EXTRA_COMMANDS.indexOf(c), 1);
});
function register(c: Command) {
  EXTRA_COMMANDS.push(c);
  added.push(c);
}

test("extra commands are dispatched and listed in help", async () => {
  register({ name: "hello", usage: "hello <name>                                  say hello", run: (args) => ({ code: 0, out: `hi ${args[0]}`, err: "" }) });
  expect(findCommand("hello")?.name).toBe("hello");
  const ctx = fakeCtx();
  expect(await main(["hello", "vu"], ctx)).toEqual({ code: 0, out: "hi vu", err: "" });
  expect((await main(["help"], ctx)).out).toContain("hello <name>");
});

test("built-ins win over extra commands; unknown names still fail", async () => {
  register({ name: "status", usage: "status (shadow)", run: () => ({ code: 99, out: "shadow", err: "" }) });
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  expect((await main(["status", "--json"], ctx)).code).toBe(0);
  expect((await main(["nope"], ctx)).code).toBe(2);
});

test("execution and classifier sections pass through; missing sections normalize to empty objects", () => {
  const withSections = validateStrategy({
    planner: "claude-code", providers: { "claude-code": {} },
    execution: { backend: "orca", worktree: "new-child" },
    classifier: { default: "rules", decisions: { guard: { use: "rules" } } },
  }, "/x");
  expect(withSections.execution).toEqual({ backend: "orca", worktree: "new-child" });
  expect(withSections.classifier).toEqual({ default: "rules", decisions: { guard: { use: "rules" } } });
  const bare = validateStrategy({ planner: "claude-code", providers: { "claude-code": {} } }, "/x");
  expect(bare.execution).toEqual({});
  expect(bare.classifier).toEqual({});
});
