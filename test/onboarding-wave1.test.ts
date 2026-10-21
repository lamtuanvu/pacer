import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { validateStrategy } from "../src/config/strategy";
import { starterStrategy, detect } from "../src/install/init";
import { computeStatus } from "../src/engine/status";
import { decideGuard } from "../src/guard/guard";
import { defaultHooks } from "../src/classify/hooks";
import { renderText } from "../src/render/text";
import { loginIndicator } from "../src/install/login";
import { runDoctor } from "../src/install/doctor";
import { claudeConnectPreview } from "../src/install/claude";
import { agentPlans } from "../src/install/detection";
import { fakeCtx } from "./helpers";

test("Claude-only starter has no invented executor and status, route, hook and doctor work", async () => {
  const ctx = fakeCtx({ which: bin => bin === "claude" ? "/fixture/claude" : null });
  const text = starterStrategy(await detect(ctx));
  const strategy = validateStrategy(Bun.YAML.parse(text), "test");
  expect(Object.keys(strategy.providers)).toEqual(["claude-code"]);
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), text);
  expect((await computeStatus(ctx, strategy)).executors.ranked).toEqual([]);
  const route = await main(["route", "--json"], ctx);
  expect(route.code).toBe(0);
  expect(JSON.parse(route.out)).toMatchObject({ ranked: [], reason: "no executor configured" });
  expect((await main(["status", "--hook", "claude-code"], ctx)).code).toBe(0);
  const checks = await runDoctor(ctx);
  expect(checks.find(c => c.name === "Executor")).toMatchObject({ level: "warn", fix: "install an executor CLI such as codex, then run pacer init" });
  expect((await main(["doctor"], ctx)).code).toBe(0);
});

test("UNKNOWN planner usage is honest and guard observes even a classifier denial", async () => {
  const ctx = fakeCtx();
  const s = validateStrategy(Bun.YAML.parse(starterStrategy(await detect(ctx))), "test");
  const st = await computeStatus(ctx, s);
  st.executors.ranked = [{ id: "codex", score: 1, verdict: "UNKNOWN", reason: "unknown" }];
  const text = renderText(st);
  expect(text).toContain("usage not measured yet (waiting for the first status-line update)");
  expect(text).not.toContain("is on pace");
  expect((await decideGuard(ctx, { subagentType: "general-purpose", prompt: "Implement" }, {
    status: async () => st,
    hooks: { ...defaultHooks, guard: async () => ({ allow: false, adapter: "test", confidence: 1 }) },
  })).allow).toBe(true);
});

test("signed-out executors are excluded without subprocess login probes", async () => {
  const ctx = fakeCtx({ which: bin => ["claude", "codex", "agy"].includes(bin) ? `/fixture/${bin}` : null });
  const s = validateStrategy(Bun.YAML.parse(starterStrategy(await detect(ctx))), "test");
  ctx.run = async () => { throw Error("no subprocess allowed"); };
  expect((await computeStatus(ctx, s)).executors.excluded).toContainEqual(expect.objectContaining({ id: "codex", account: "codex", reason: "signed out — run codex login" }));
  mkdirSync(join(ctx.home, ".codex"), { recursive: true });
  writeFileSync(join(ctx.home, ".codex/auth.json"), "{}");
  const st = await computeStatus(ctx, s);
  expect(st.executors.ranked.map(e => e.id)).toContain("codex");
  expect(st.executors.ranked.map(e => e.id)).toContain("agy");
});

test("missing strategy points directly to init", async () => {
  const ctx = fakeCtx();
  expect((await main(["status"], ctx)).err).toBe(`pacer: no strategy at ${join(ctx.pacerHome, "strategy.yaml")}. Run: pacer init`);
});

test("Claude preview discloses new status line or preserves existing status line with pipe advice", () => {
  const ctx = fakeCtx({ which: bin => bin === "claude" ? "/fixture/claude" : null });
  const preview = () => claudeConnectPreview(ctx.home);
  expect(preview()).toContain("SessionStart + PreToolUse hooks, and the status line (pacer statusline) because none is set");
  mkdirSync(join(ctx.home, ".claude"), { recursive: true });
  writeFileSync(join(ctx.home, ".claude/settings.json"), JSON.stringify({ statusLine: { command: "custom-status" } }));
  expect(preview()).toContain("existing status line will be left alone");
  expect(preview()).toContain("pacer statusline");
});


test("OpenCode-only starter migrates without inventing a budget account or executor", async () => {
  const ctx = fakeCtx({ which: bin => bin === "opencode" ? "/fixture/opencode" : null });
  const strategy = validateStrategy(Bun.YAML.parse(starterStrategy(await detect(ctx))), "test");
  expect(Object.keys(strategy.providers)).toEqual([]);
  expect((await computeStatus(ctx, strategy)).executors.ranked).toEqual([]);
});

test("login indicators respect config folders and uncheckable providers", () => {
  const ctx = fakeCtx({ env: { CODEX_HOME: "/nonexistent-config" } });
  const folder = join(ctx.home, "codex-work");
  mkdirSync(folder);
  writeFileSync(join(folder, "auth.json"), "{}");
  expect(loginIndicator(ctx, "codex")?.loggedIn).toBe(false);
  expect(loginIndicator(ctx, "codex", folder)?.loggedIn).toBe(true);
  ctx.env.CODEX_HOME = folder;
  expect(loginIndicator(ctx, "codex")?.loggedIn).toBe(true);
  expect(loginIndicator(ctx, "agy")).toBeNull();
});

test("remote runners are not excluded by missing local login indicators", async () => {
  const ctx = fakeCtx({ which: bin => bin === "claude" || bin === "codex" ? `/fixture/${bin}` : null });
  const strategy = validateStrategy(Bun.YAML.parse(starterStrategy(await detect(ctx))), "test");
  strategy.runners.codex.host = "remote";
  expect((await computeStatus(ctx, strategy)).executors.ranked.map(e => e.id)).toContain("codex");
});

test("malformed Claude settings do not break read-only agent discovery", () => {
  const ctx = fakeCtx({ which: bin => bin === "claude" ? "/fixture/claude" : null });
  mkdirSync(join(ctx.home, ".claude"), { recursive: true });
  writeFileSync(join(ctx.home, ".claude/settings.json"), "{broken");
  expect(agentPlans(ctx.home, ctx.pacerHome, ctx.which)).toHaveLength(1);
  expect(claudeConnectPreview(ctx.home)).toContain("cannot preview malformed settings");
});
