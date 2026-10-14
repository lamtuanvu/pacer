import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateStrategy } from "../src/config/migrate";
import { validateStrategy } from "../src/config/strategy";
import { initCmd } from "../src/install/init";
import { refreshIntegrations } from "../src/commands/update-refresh";
import { main } from "../src/cli";
import { setupCmd } from "../src/commands/setup";
import { defaultUpdateDeps, runUpdate } from "../src/update/update";
import { fakeCtx, tmpDir } from "./helpers";

const starter = `# starter shape
planner: claude-code # planning account
providers:
  # Claude budget
  claude-code: {usage: quota}
  codex: {usage: quota, allow_paid: false} # no paid fallback
  cursor: {usage: reactive, model: auto, cooldown: 6h}
  agy: {usage: reactive}
  # Hosted endpoint
  byteplus: {via: opencode, model: "coding-plan/dola-seed-2.0-code", usage: quota, quota_source: arkcli}
  local: {via: opencode, model: "ollama/qwen3", usage: unmetered}
# Keep pacing layout
pacing: {policy: priority, order: [codex, cursor, agy, opencode]}
routing:
  - kinds: [docs, tests]
    executors: [codex, local]
  - default: [codex, cursor, agy, byteplus, local]
execution: {backend: direct}
`;
const parse = (text: string) => validateStrategy(Bun.YAML.parse(text), "strategy.yaml");
function fixture(text = starter) { const path = join(tmpDir(), "strategy.yaml"); writeFileSync(path, text); return path; }

test("migration backs up the starter and retains runner, routing, budget and comment semantics", () => {
  const path = fixture(); const before = parse(starter);
  const result = migrateStrategy(path);
  expect(result.changed).toBe(true);
  expect(result.backup).toBe(`${path}.pre-accounts.bak`);
  expect(readFileSync(result.backup!, "utf8")).toBe(starter);
  const migrated = readFileSync(path, "utf8"); const after = parse(migrated);
  expect(after.legacy).toBe(false);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.planner).toEqual(before.planner);
  expect(after.runners).toEqual(before.runners);
  expect(after.providers).toEqual(before.providers);
  expect(after.pacing).toEqual(before.pacing);
  expect(after.routing).toEqual(before.routing);
  expect(migrated).toContain("# Claude budget");
  expect(migrated).toContain("# Hosted endpoint");
  expect(migrated).toContain("# no paid fallback");
  expect(migrated.split("# Claude budget").length - 1).toBe(1);
  expect(migrated).toContain(starter.slice(starter.indexOf("# Keep pacing layout")));
  expect(migrateStrategy(path)).toEqual({ changed: false, summary: [] });
  expect(readFileSync(path, "utf8")).toBe(migrated);
  expect(readFileSync(result.backup!, "utf8")).toBe(starter);
});

test("migration preserves implicit legacy pacing order and a planner without a provider", () => {
  const original = `planner: claude-code\nproviders:\n  codex: {usage: quota}\n  local: {via: opencode, model: ollama/qwen3, usage: unmetered}\n`;
  const path = fixture(original); migrateStrategy(path);
  const after = parse(readFileSync(path, "utf8"));
  expect(after.legacy).toBe(false);
  expect(after.pacing.order).toEqual(["codex", "opencode"]);
  expect(after.accounts["claude-code"].kind).toBe("claude");
  expect(after.runners).toEqual(parse(original).runners);
});

test("actual init setup migrates existing strategy and stays idempotent", async () => {
  const ctx = fakeCtx({ which: bin => bin === "claude" ? "/fake/claude" : null });
  mkdirSync(ctx.pacerHome, { recursive: true }); const path = join(ctx.pacerHome, "strategy.yaml");
  writeFileSync(path, starter);
  const deps = { tty: false, orcaInstalled: false, service: () => ({ status: async () => ({ installed: true, loaded: false, running: false, pid: null,
    lastExitCode: null, healthy: false, plistPath: "unused", binaryPath: null, binaryMatches: false }), install: async () => [] }) };
  const result = await setupCmd(["--no-dashboard"], ctx, deps);
  expect(result.code).toBe(0); expect(result.out).toContain("Restore:");
  const migrated = readFileSync(path, "utf8"); expect(parse(migrated).legacy).toBe(false);
  expect((await setupCmd(["--no-dashboard"], ctx, deps)).code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(migrated);
});

test("migration keeps aliased provider settings and flow provider mappings", () => {
  for (const original of [
    `planner: codex\nproviders:\n  claude-code: &quota {usage: quota, allow_paid: true}\n  codex: *quota\n`,
    `planner: codex\nproviders: {codex: {usage: quota}, local: {via: opencode, model: ollama/qwen3, usage: unmetered}} # budgets\n`,
    `{planner: codex, providers: {codex: {usage: quota}}}\n`,
    `planner: codex\nproviders:\n  codex: {usage: quota, model: 123}\n`,
  ]) {
    const before = parse(original); const path = fixture(original); migrateStrategy(path);
    const after = parse(readFileSync(path, "utf8"));
    expect(after.legacy).toBe(false); expect(after.accounts).toEqual(before.accounts);
    expect(after.providers).toEqual(before.providers); expect(after.pacing).toEqual(before.pacing);
  }
});

test("up-to-date update migrates even with no reinstall, while check stays read-only", async () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  const path = join(ctx.pacerHome, "strategy.yaml"); writeFileSync(path, starter);
  const deps = { ...defaultUpdateDeps(ctx), standalone: true, execPath: join(ctx.home, "binary"),
    fetch: async () => new Response(JSON.stringify({ version: "0.1.23" })) };
  expect((await runUpdate({ check: true }, deps)).code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(starter);
  const result = await runUpdate({ check: false, noReinstall: true }, deps);
  expect(result.code).toBe(0); expect(result.out).toContain("Restore:");
  expect(parse(readFileSync(path, "utf8")).legacy).toBe(false);
});

test("OpenCode default planner never invents an endpoint budget account", () => {
  const original = `planner: opencode\nproviders:\n  local: {via: opencode, model: ollama/qwen3, usage: unmetered}\n`;
  expect(Object.keys(parse(original).accounts)).toEqual(["local"]);
  const path = fixture(original); migrateStrategy(path);
  const after = parse(readFileSync(path, "utf8"));
  expect(Object.keys(after.accounts)).toEqual(["local"]);
  expect(after.planner).toEqual({ agent: "opencode", account: "opencode" });
});

test("invalid migration and conflicting backup leave both files unchanged", () => {
  const path = fixture("planner: invalid\nproviders: {}\n");
  expect(() => migrateStrategy(path)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("planner: invalid\nproviders: {}\n");
  expect(existsSync(`${path}.pre-accounts.bak`)).toBe(false);
  writeFileSync(path, starter); writeFileSync(`${path}.pre-accounts.bak`, "first backup");
  expect(() => migrateStrategy(path)).toThrow("backup");
  expect(readFileSync(path, "utf8")).toBe(starter);
  expect(readFileSync(`${path}.pre-accounts.bak`, "utf8")).toBe("first backup");
});

test("init and update refresh migrate and print a usable restore command", async () => {
  const ctx = fakeCtx({ which: bin => ["claude", "codex"].includes(bin) ? `/fake/${bin}` : null });
  const result = await initCmd(ctx); const path = join(ctx.pacerHome, "strategy.yaml");
  expect(result.code).toBe(0); expect(parse(readFileSync(path, "utf8")).legacy).toBe(false);
  expect(result.out).toContain("accounts"); expect(result.out).toContain("Restore:");
  expect(result.out).toContain(".pre-accounts.bak");
  writeFileSync(path, starter); // re-use the exact backup only when it matches
  const updateCtx = fakeCtx(); mkdirSync(updateCtx.pacerHome, { recursive: true });
  const updatePath = join(updateCtx.pacerHome, "strategy.yaml"); writeFileSync(updatePath, starter);
  const lines = await refreshIntegrations(updateCtx, "/fake/new-pacer");
  expect(parse(readFileSync(updatePath, "utf8")).legacy).toBe(false);
  expect(lines.join("\n")).toContain("Restore:");
  expect(readFileSync(`${updatePath}.pre-accounts.bak`, "utf8")).toBe(starter);
});

test("config migrate targets the active strategy and ordinary reads never migrate", async () => {
  const ctx = fakeCtx(); mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), starter);
  const path = join(ctx.pacerHome, "strategies", "work.yaml"); writeFileSync(path, starter);
  writeFileSync(join(ctx.pacerHome, "active"), "work\n");
  const beforeRoute = await main(["route", "--json"], ctx);
  expect(readFileSync(path, "utf8")).toBe(starter);
  const result = await main(["config", "migrate"], ctx);
  expect(result.code).toBe(0); expect(result.out).toContain("Restore:");
  expect(parse(readFileSync(path, "utf8")).legacy).toBe(false);
  expect(await main(["route", "--json"], ctx)).toEqual(beforeRoute);
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toBe(starter);
  expect((await main(["config", "migrate", "extra"], ctx)).code).toBe(2);
});
