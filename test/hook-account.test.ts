import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";
function accountCtx() {
 const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive: true});
 writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  personal: {kind: claude}\n  work: {kind: claude, home: ~/.work-agent}\nplanner: claude-code#work\nrouting:\n  - default: [claude-code]\n"); return ctx;
}
import { statusLine } from "../src/install/statusline";

async function fixture() {
  const ctx = accountCtx();
  mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true });
  for (const [file, used] of [["claude-rate-limits.json", 10], ["claude-rate-limits.work.json", 99]] as const)
    writeFileSync(join(ctx.pacerHome, "cache", file), JSON.stringify({ seven_day: {used_percentage: used, resets_at: ctx.now + 86400}, captured_at: ctx.now }));
  return ctx;
}
test("hook resolves the actual planner account from its environment", async () => {
  const ctx = await fixture();
  const path = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(path, (await Bun.file(path).text()).replace("planner: claude-code#work", "planner: claude-code"));
  ctx.env.CLAUDE_CONFIG_DIR = join(ctx.home, ".work-agent");
  const r = await main(["status", "--hook", "claude-code"], ctx);
  expect(r.code).toBe(0); expect(r.out).toContain("Mode: EMERGENCY"); expect(r.out).toContain("Claude Code (work)'s quota");
});
test("hook unknown folder falls back to default budget with visible structured warning", async () => {
  const ctx = await fixture(); ctx.env.CLAUDE_CONFIG_DIR = join(ctx.home, "unknown");
  const r = await main(["status", "--hook", "claude-code"], ctx);
  expect(r.out).toContain("Claude may do small and medium edits");
  expect(r.out).toContain("Mode: RELAXED");
  expect(JSON.parse(r.out).warnings).toEqual(["planner session runs on an unknown config folder"]);
});
test("status line uses the account the session actually runs on", async () => {
  const ctx = await fixture(); ctx.env.CLAUDE_CONFIG_DIR = join(ctx.home, ".claude");
  const line = await statusLine(ctx, "{}");
  expect(line).toContain("relaxed");
});

test("Codex hooks select CODEX_HOME and warn when it is unknown", async () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "accounts:\n  personal: {kind: codex}\n  work: {kind: codex, home: ~/.work-agent}\nplanner: codex#work\nrouting:\n  - default: [codex]\n");
  for (const [folder, used] of [[".codex", 10], [".work-agent", 99]] as const) {
    mkdirSync(join(ctx.home, folder, "sessions"), {recursive: true});
    writeFileSync(join(ctx.home, folder, "sessions/rollout-test.jsonl"), JSON.stringify({rate_limits: {primary: {used_percent: used, window_minutes: 10080, resets_at: ctx.now + 86400}}}));
  }
  ctx.env.CODEX_HOME = join(ctx.home, ".work-agent");
  expect((await main(["status", "--hook", "codex"], ctx)).out).toContain("Mode: EMERGENCY");
  ctx.env.CODEX_HOME = join(ctx.home, "unknown");
  const r = await main(["status", "--hook", "codex"], ctx);
  expect(r.out).toContain("Mode: RELAXED");
  expect(r.out).toContain("Warning: planner session runs on an unknown config folder");
});
