import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED } from "../plugins/bundled";
import { manifest as orcaManifest } from "../plugins/pacer-exec-orca/manifest";
import { mapWait } from "../plugins/pacer-exec-orca/index";
import { bundledPluginSpawn } from "../src/plugins";
import { CAPABILITIES, CAPABILITY_METHODS, EXTENSION_METHODS, manifestSchema } from "../src/plugins/protocol";
import { PluginRegistry } from "../src/plugins/registry";
import { fakeCtx } from "./helpers";

const task = { id: "t-20261031-120000-abcd", rev: 3 };
const run = EXTENSION_METHODS["executor.run"]!;
const orca = { executor: "codex", model: null, timeoutMs: 60_000 };

test("the 1.10.0 Orca run variant carries only host-selected identity and bounds", () => {
  expect(run.params.safeParse({ task, attempt: 1, runDir: 1, orca }).success).toBe(true);
  expect(run.params.safeParse({ task, attempt: 1, runDir: 1, orca: { ...orca, session: "interactive" } }).success).toBe(true);
  for (const bad of [{ ...orca, argv: ["sh", "-c", "x"] }, { ...orca, env: { KEY: "secret" } }, { ...orca, cwd: "/tmp" },
    { ...orca, worktree: "id:x" }, { ...orca, terminal: "term_1" }, { ...orca, timeoutMs: 31 * 60 * 1000 }, { ...orca, session: "pty" }])
    expect(run.params.safeParse({ task, attempt: 1, runDir: 1, orca: bad }).success).toBe(false);
  expect(run.params.safeParse({ task: { id: "../t-1", rev: 3 }, attempt: 1, runDir: 1, orca }).success).toBe(false);
  expect(run.params.safeParse({ task, attempt: 0, runDir: 1, orca }).success).toBe(false);
  expect(run.result.safeParse({ orca: { fallback: { reason: "the Orca runtime is not ready" } } }).success).toBe(true);
  expect(run.result.safeParse({ orca: { refused: { reason: "current worktree has uncommitted changes" } } }).success).toBe(true);
  for (const bad of [{ orca: { fallback: { reason: "" } } }, { orca: { fallback: { reason: "x".repeat(4097) } } },
    { orca: { fallback: { reason: "r" }, refused: { reason: "r" } } }, { orca: { direct: { argv: ["sh"] } } }])
    expect(run.result.safeParse(bad).success).toBe(false);
});

test("session state names the Orca live terminal; the direct owner keeps its builtin shape", () => {
  const state = EXTENSION_METHODS["executor.sessionState"]!.result;
  expect(state.safeParse({ state: "running", host: "orca", handle: "term_1" }).success).toBe(true);
  expect(state.safeParse({ state: "uncertain", host: "orca", handle: null }).success).toBe(true);
  expect(state.safeParse({ state: "running", host: "builtin", handle: null }).success).toBe(true);
  expect(state.safeParse({ state: "running", host: "builtin", handle: "term_1" }).success).toBe(false);
  expect(state.safeParse({ state: "running", host: "orca", handle: "x".repeat(257) }).success).toBe(false);
});

test("every orca capability method is owner-bound and strict, and its receipts are bounded", () => {
  const names = Object.keys(CAPABILITY_METHODS).filter(name => name.startsWith("capability.orca."));
  expect(names.sort()).toEqual(["abandon", "adopt", "finish", "liveAnswer", "lookup", "place", "prepare", "sessionState", "settle",
    "start", "status", "stop", "terminal", "unstarted", "wait"].map(name => `capability.orca.${name}`).sort());
  expect(CAPABILITIES).toContain("orca");
  for (const name of names.filter(name => name !== "capability.orca.status")) {
    const params = CAPABILITY_METHODS[name]!.params;
    expect(params.safeParse({ taskId: task.id, attempt: 1, argv: ["sh"] }).success).toBe(false);
    expect(params.safeParse({ taskId: "not-a-task", attempt: 1 }).success).toBe(false);
  }
  expect(CAPABILITY_METHODS["capability.orca.status"]!.params.safeParse({ taskId: task.id }).success).toBe(false);
  const start = CAPABILITY_METHODS["capability.orca.start"]!.result;
  expect(start.safeParse({ kind: "started", dispatchId: "ctx_1", state: "ready", stage: null, failedStage: null, lastError: null }).success).toBe(true);
  expect(start.safeParse({ kind: "started", dispatchId: "", state: "ready", stage: null, failedStage: null, lastError: null }).success).toBe(false);
  expect(CAPABILITY_METHODS["capability.orca.wait"]!.result.safeParse({ kind: "done", outcome: "succeeded", subject: "s", body: "x".repeat(65_537) }).success).toBe(false);
  expect(CAPABILITY_METHODS["capability.orca.finish"]!.params.safeParse({ taskId: task.id, attempt: 1, code: 0, timedOut: false,
    settled: true, summary: "ok", keepAlive: false, terminal: "term_user" }).success).toBe(false);
});

test("an orca capability or backend gates on host >=1.10.0, and the bundled provider declares exactly that", () => {
  const base = { id: "fx-orca", version: "1.0.0", publisher: "test" };
  expect(manifestSchema.safeParse({ ...base, host: ">=1.9.0", capabilities: [{ name: "orca" }] }).success).toBe(false);
  expect(manifestSchema.safeParse({ ...base, host: ">=1.9.0", contributes: { executor: { backends: ["orca"] } } }).success).toBe(false);
  expect(manifestSchema.safeParse({ ...base, host: ">=1.10.0", capabilities: [{ name: "orca" }], contributes: { executor: { backends: ["orca"] } } }).success).toBe(true);
  expect(manifestSchema.parse(orcaManifest)).toMatchObject({ id: "pacer-exec-orca", host: ">=1.10.0",
    contributes: { executor: { backends: ["orca"] } }, capabilities: [{ name: "orca", scopes: ["task-owned"] }] });
  expect(BUNDLED.map(plugin => plugin.manifest.id)).toContain("pacer-exec-orca");
});

test("the provider maps waits as #461 did: only a reported or settled worker is released", () => {
  expect(mapWait({ kind: "done", outcome: "succeeded", subject: "done", body: "ok" })).toEqual({ code: 0, timedOut: false, settled: true, summary: "done\n\nok" });
  expect(mapWait({ kind: "settled", state: "needs_input", error: null, needsStop: true })).toMatchObject({ code: 1, settled: false });
  expect(mapWait({ kind: "timeout" })).toMatchObject({ code: 1, timedOut: true, settled: false });
  expect(mapWait({ kind: "stopped" })).toMatchObject({ code: 1, settled: false, summary: "stopped by the planner; stopped the orca worker" });
});

test("production registry lists the bundled Orca provider; unissued Orca effects are refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-bundled-orca-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH ?? "" },
    run: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, result: { runtime: { state: "starting", reachable: true } } }), stderr: "" }) });
  const registry = new PluginRegistry({ bundled: BUNDLED, spawnBundled: bundledPluginSpawn });
  try {
    expect(registry.list(ctx).find(item => item.id === "pacer-exec-orca")).toMatchObject({ bundled: true, enabled: true, contributes: ["executor"] });
    expect((await registry.doctor(ctx, "pacer-exec-orca"))[0]).toMatchObject({ ok: true });
    expect(await registry.call(ctx, "pacer-exec-orca", "executor.available", { strategy: { name: "default" } },
      { resources: { reads: [], commands: [], stores: [] } })).toEqual({ available: false, reason: "the Orca runtime is not ready (orca status)" });
    // No host-issued attempt: the provider cannot reach a single Orca effect.
    await expect(registry.call(ctx, "pacer-exec-orca", "executor.run", { task, attempt: 1, runDir: 1, orca },
      { resources: { reads: [], commands: [], stores: [] }, onProgress: () => {}, deadlineMs: 10_000 })).rejects.toMatchObject({ code: "capability_denied" });
    await expect(registry.call(ctx, "pacer-exec-orca", "executor.sessionState", { taskId: task.id, attempt: 1 },
      { resources: { reads: [], commands: [], stores: [] }, deadlineMs: 5000 })).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
