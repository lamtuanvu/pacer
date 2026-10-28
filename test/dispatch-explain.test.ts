import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { assertCallerCanInvoke } from "../src/api/caller-policy";
import { validateStrategy } from "../src/config/strategy";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { explainDispatch } from "../src/core/dispatch-explain";
import { previewDispatch } from "../src/core/dispatch";
import { blockExecutor } from "../src/executors/blocked";
import { pause } from "../src/core/pause";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import type { Status } from "../src/engine/status";

function setup(used: Record<string, number | null>, extra: Record<string, unknown> = {}) {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  const strategy = validateStrategy({ planner: "claude-code", accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex" }, cursor: { kind: "cursor" } },
    runners: { codex: { models: [{ id: "provider/deep", tier: "frontier" }] }, cursor: { models: [{ id: "provider/mid", tier: "medium" }] } }, ...extra }, "test");
  const status = async (): Promise<Status> => ({ generatedAt: ctx.now, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false,
    providers: Object.entries(used).map(([id, pct]) => ({ id, usage: "quota" as const, windows: pct === null ? [] : [{ name: "weekly", usedPct: pct, resetsAt: ctx.now + 3600, lengthS: 604800, paced: true, verdict: "ON_PACE" as const }], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
    accounts: Object.entries(used).map(([id, pct]) => ({ name: id, kind: id === "claude-code" ? "claude" as const : id === "codex" ? "codex" as const : "cursor" as const, verdict: "ON_PACE" as const, usedPct: pct, pacePct: 40, resetsAt: ctx.now + 3600, window: "weekly", stale: false, source: null, capturedAt: ctx.now, runners: [id], spendUsd: null })),
    executors: { ranked: [], excluded: [] } });
  return { ctx, strategy, deps: { strategy, status } };
}
const input = () => ({ repo: tmpDir(), goal: "Fix the login bug", delegationEnforcement: "cooperative" as const });

test("an eligible executor is chosen with the ladder step and passing reasons", async () => {
  const { ctx, deps } = setup({ "claude-code": 10, codex: 20, cursor: 30 });
  const r = await explainDispatch(ctx, input(), deps);
  expect(r.outcome).toBe("select");
  expect(r.kind).toEqual({ value: "debug", source: "detected" });
  expect(r.chosen).toMatchObject({ executor: "codex", account: "codex", model: { kind: "exact", id: "provider/deep" }, host: null });
  expect(r.step).toMatchObject({ id: "capable-with-headroom", index: 0 });
  expect(r.reasons.map(x => x.code)).toEqual(["step_match", "capacity_comfortable"]);
  expect(r.reasons.every(x => x.outcome === "pass" && x.text.length > 0)).toBe(true);
  expect(r.fallbacks.map(f => [f.executor, f.state])).toContainEqual(["cursor", "eligible"]);
  expect(r.planner).toMatchObject({ state: "unknown", reason: "planner_not_measured", window: { account: "claude-code", usedPct: 10, pacePct: 40 } });
  expect(r.uncertainty.map(x => x.code)).toContain("cached_preview");
  // The explanation agrees with the decision code it reuses.
  const direct = await previewDispatch(ctx, { repo: input().repo, goal: "x", kind: "debug", delegationEnforcement: "cooperative" }, deps);
  const proposal = direct.proposal;
  if (proposal?.state !== "ranked") throw new Error("expected a ranked proposal");
  expect(direct.request.candidates.find(c => c.id === proposal.choices[0].id)?.runner).toBe(r.chosen!.runner);
});

test("skipped steps carry reasons and a later-step executor is listed with its step", async () => {
  const { ctx, deps, strategy } = setup({ "claude-code": 10, codex: 95, cursor: 30 });
  const base = dispatchConfigSchema.parse({});
  strategy.dispatch = { ...base, steps: [
    { id: "docs-only", match: { kind: "docs" }, require: {}, prefer: { models: [], strengths: [] }, candidates: {}, capacity: "comfortable", rank: ["task-fit", "spare-capacity"] },
    ...base.steps] };
  const r = await explainDispatch(ctx, { ...input(), kind: "debug" }, deps);
  expect(r.step!.skipped[0]).toEqual({ id: "docs-only", reason: "step_kind_mismatch" });
  expect(r.chosen!.executor).toBe("cursor");
  expect(r.fallbacks.find(f => f.executor === "codex")).toMatchObject({ state: "eligible", step: "usable-fallback" });
});

test("excluded executors are listed with coded reasons", async () => {
  const { ctx, deps } = setup({ "claude-code": 10, codex: 100, cursor: 30 });
  const r = await explainDispatch(ctx, input(), deps);
  const codex = r.fallbacks.find(f => f.executor === "codex");
  expect(codex).toMatchObject({ state: "excluded", reason: { code: "quota_exhausted", outcome: "fail" } });
  expect(r.chosen!.executor).toBe("cursor");
});

test("no eligible executor queues or fails according to onNoMatch", async () => {
  const { ctx, deps, strategy } = setup({ "claude-code": 10, codex: 100, cursor: 100 });
  const queued = await explainDispatch(ctx, input(), deps);
  expect(queued).toMatchObject({ outcome: "queue", chosen: null });
  expect(queued.reasons.map(x => x.code)).toContain("no_step_matched");
  strategy.dispatch = dispatchConfigSchema.parse({ onNoMatch: "fail" });
  expect((await explainDispatch(ctx, input(), deps)).outcome).toBe("fail");
});

test("an override picks an eligible executor, refuses an exhausted one and falls back otherwise", async () => {
  const eligible = setup({ "claude-code": 10, codex: 20, cursor: 30 });
  const picked = await explainDispatch(eligible.ctx, { ...input(), executor: "cursor" }, eligible.deps);
  expect(picked).toMatchObject({ outcome: "override", chosen: { executor: "cursor" } });
  expect(picked.reasons[0]).toMatchObject({ code: "override", outcome: "info" });

  const exhausted = setup({ "claude-code": 10, codex: 100, cursor: 30 });
  const refused = await explainDispatch(exhausted.ctx, { ...input(), executor: "codex" }, exhausted.deps);
  expect(refused).toMatchObject({ outcome: "fail", chosen: null });
  expect(refused.reasons.map(x => x.code)).toEqual(["override", "quota_exhausted"]);

  const planner = setup({ "claude-code": 10, codex: 20, cursor: 30 });
  const fallback = await explainDispatch(planner.ctx, { ...input(), executor: "claude-code" }, planner.deps);
  expect(fallback.outcome).toBe("select");
  expect(fallback.chosen!.executor).toBe("codex");
  expect(fallback.reasons.map(x => x.code)).toContain("override_unavailable");
});

test("a paused dispatcher queues with the pause reason", async () => {
  const { ctx, deps } = setup({ "claude-code": 10, codex: 20, cursor: 30 });
  pause(ctx, { for: "1h" });
  const r = await explainDispatch(ctx, input(), deps);
  expect(r).toMatchObject({ outcome: "queue", chosen: null });
  expect(r.reasons[r.reasons.length - 1].code).toBe("paused");
});

test("kind: given, detected and unknown; unknown kind and executor are errors", async () => {
  const { ctx, deps } = setup({ "claude-code": 10, codex: 20, cursor: 30 });
  expect((await explainDispatch(ctx, { ...input(), kind: "docs" }, deps)).kind).toEqual({ value: "docs", source: "given" });
  expect((await explainDispatch(ctx, { ...input(), goal: "Hmm, thoughts?" }, deps)).kind).toEqual({ value: null, source: "unknown" });
  await expect(explainDispatch(ctx, { ...input(), kind: "magic" }, deps)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(explainDispatch(ctx, { ...input(), executor: "nope" }, deps)).rejects.toMatchObject({ code: "unknown_executor" });
  await expect(explainDispatch(ctx, { ...input(), extra: 1 }, deps)).rejects.toMatchObject({ code: "invalid_input" });
});

test("revision is stable over the same facts and changes with them", async () => {
  const { ctx, deps } = setup({ "claude-code": 10, codex: 20, cursor: 30 });
  const a = await explainDispatch(ctx, input(), deps), b = await explainDispatch(ctx, input(), deps);
  expect(a.revision).toBe(b.revision);
  const other = setup({ "claude-code": 10, codex: 60, cursor: 30 });
  expect((await explainDispatch(other.ctx, input(), other.deps)).revision).not.toBe(a.revision);
});

test("strategyDraft explains an unsaved draft and reports its problems", async () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const ok = await explainDispatch(ctx, { ...input(), strategyDraft: { from: "default", set: { dispatch: { onNoMatch: "fail" } } } });
  expect(ok.strategy).toMatchObject({ draft: true });
  await expect(explainDispatch(ctx, { ...input(), strategyDraft: { from: "default", set: { dispatch: { onNoMatch: "bogus" } } } })).rejects.toMatchObject({ code: "invalid_input" });
});

test("executor sessions and grants are refused", async () => {
  const { ctx, deps } = setup({ "claude-code": 10 });
  await expect(explainDispatch({ ...ctx, env: { PACER_ROLE: "executor" } }, input(), deps)).rejects.toMatchObject({ code: "not_allowed" });
  await expect(explainDispatch({ ...ctx, env: { PACER_WORK_GRANT: "g" } }, input(), deps)).rejects.toMatchObject({ code: "not_allowed" });
  expect(() => assertCallerCanInvoke({ ...ctx, env: { PACER_ROLE: "executor" } }, "dispatch.explain", {})).toThrow();
});

function snapshot(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) { const p = join(dir, name), s = statSync(p); out.push(`${p}:${s.mode}:${s.size}:${s.mtimeMs}`); if (s.isDirectory()) walk(p); } };
  walk(root); return out;
}
test("explain writes nothing and runs no agent binary, on a fresh and an initialized home", async () => {
  const calls: string[][] = [];
  for (const initialized of [false, true]) {
    const { ctx, deps } = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    if (initialized) {
      const { taskDatabase } = await import("../src/dispatch/../tasks/store");
      taskDatabase(ctx); // a real store, created before the snapshot
      writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
    }
    ctx.run = async argv => { calls.push(argv); if (argv[0] === "git") return { code: 1, stdout: "", stderr: "" }; throw new Error(`unexpected spawn: ${argv.join(" ")}`); };
    const before = snapshot(ctx.pacerHome);
    for (let i = 0; i < 5; i++) await explainDispatch(ctx, { repo: tmpDir(), goal: "Fix a bug" }, deps);
    expect(snapshot(ctx.pacerHome)).toEqual(before);
  }
  expect(calls.every(c => c[0] === "git")).toBe(true);
});

test("the dispatch.explain operation matches the core result", async () => {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const params = { repo: tmpDir(), goal: "Check the docs" };
  const api = await callOp(ctx, "dispatch.explain", params);
  expect(api).toEqual(await explainDispatch(ctx, params));
  await expect(callOp(ctx, "dispatch.explain", { ...params, bogus: 1 })).rejects.toMatchObject({ code: "invalid_input" });
});

test("an executor you blocked is excluded, and requesting it refuses the task", async () => {
  const { ctx, deps } = setup({ "claude-code": 10, codex: 20, cursor: 30 });
  blockExecutor(ctx, "codex");
  const r = await explainDispatch(ctx, input(), deps);
  expect(r.chosen!.executor).toBe("cursor");
  expect(r.fallbacks.find(f => f.executor === "codex")?.reason?.code).toBe("blocked_by_user");
  const refused = await explainDispatch(ctx, { ...input(), executor: "codex" }, deps);
  expect(refused).toMatchObject({ outcome: "fail", chosen: null });
});

test("pacer route --explain prints the explanation and --json matches the operation", async () => {
  const { main } = await import("../src/cli");
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const repo = tmpDir();
  expect((await main(["route", "--explain", "--repo", repo], ctx)).code).toBe(2);
  const text = await main(["route", "--explain", "--repo", repo, "--goal", "Write docs"], ctx);
  expect(text.code).toBe(0);
  expect(text.out).toContain("kind: docs (detected)");
  const json = await main(["route", "--explain", "--repo", repo, "--goal", "Write docs", "--json"], ctx);
  expect(JSON.parse(json.out)).toEqual(await callOp(ctx, "dispatch.explain", { repo, goal: "Write docs" }));
});

test("the documented reason codes match the code list", async () => {
  const { REASON_CODES } = await import("../src/dispatch/reasons");
  const docs = (await Bun.file(join(import.meta.dir, "../docs/dispatch.md")).text()).match(/Reason codes: (.*)\./)![1];
  expect(docs.split(", ").map(c => c.replace(/`/g, ""))).toEqual([...REASON_CODES]);
});

test("a real git repository path or a registered key writes no repo registry or task store", async () => {
  const { ctx, deps } = setup({ "claude-code": 10, codex: 20, cursor: 30 });
  ctx.run = realRun;
  const repo = gitRepo();
  const before = snapshot(ctx.pacerHome);
  expect((await explainDispatch(ctx, { repo, goal: "Fix a bug", delegationEnforcement: "cooperative" }, deps)).outcome).toBe("select");
  expect(snapshot(ctx.pacerHome)).toEqual(before);
  expect(existsSync(join(ctx.pacerHome, "state", "repos.json"))).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "state", "tasks.db"))).toBe(false);
  // An unregistered key is refused, still without creating the task store.
  await expect(explainDispatch(ctx, { repo: "owner/name", goal: "Fix" }, deps)).rejects.toMatchObject({ code: "invalid_input" });
  expect(existsSync(join(ctx.pacerHome, "state", "tasks.db"))).toBe(false);
});

test("the read-only store reads a cleanly closed WAL database", async () => {
  const { Database } = await import("bun:sqlite");
  const { openReadOnlyStore, runningTasksReadOnly } = await import("../src/dispatch/readonly");
  const ctx = fakeCtx(); mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  const db = new Database(join(ctx.pacerHome, "state", "tasks.db")); db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE tasks (id TEXT, state TEXT, record TEXT)"); db.run("INSERT INTO tasks VALUES ('t1','running','{\"id\":\"t1\",\"state\":\"running\"}')"); db.close();
  const store = openReadOnlyStore(ctx);
  expect(store.available).toBe(true);
  expect(runningTasksReadOnly(store).map(t => t.id)).toEqual(["t1"]);
  store.close();
});

test("pacer route --explain refuses an executor session before calling the service", async () => {
  const { main } = await import("../src/cli");
  const ctx = fakeCtx({ env: { PACER_ROLE: "executor" } });
  const r = await main(["route", "--explain", "--repo", tmpDir(), "--goal", "x"], ctx);
  expect(r.code).toBe(2);
});

test("an oversized strategyDraft is refused", async () => {
  const { ctx, deps } = setup({ "claude-code": 10 });
  await expect(explainDispatch(ctx, { ...input(), strategyDraft: { from: "default", description: "x".repeat(2000) } }, deps)).rejects.toMatchObject({ code: "invalid_input" });
});
