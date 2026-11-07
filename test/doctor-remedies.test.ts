import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OPS } from "../src/api/ops";
import { CoreError } from "../src/core/errors";
import type { ProviderStatus } from "../src/engine/rank";
import type { Status } from "../src/engine/status";
import { renderDoctor, runDoctor, type Check, type Remedy } from "../src/install/doctor";
import { internalCheck, internalErrorCode, isInternalCode, remedies, remedyCommand, withRemedies } from "../src/install/doctor-remedy";
import { sha256 } from "../src/install/fsx";
import { writeManifest, type FileChange } from "../src/install/manifest";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function fixture() {
  const ctx = fakeCtx();
  put(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {usage: quota}\n  codex: {usage: quota}\nrouting:\n  - default: [codex]\n");
  return ctx;
}
function status(overrides: Record<string, Partial<ProviderStatus>> = {}): Status {
  return {
    generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal",
    disabled: false, paused: null, modeHold: null, calendarPace: true, executors: { ranked: [], excluded: [] },
    providers: ["claude-code", "codex"].map(id => ({
      id, usage: "quota", windows: [], binding: null, verdict: "OK", installed: true, stale: false, ...overrides[id],
    })),
  };
}
const service = (s: Partial<{ installed: boolean; running: boolean; healthy: boolean; binaryMatches: boolean }> = {}) =>
  async () => ({ installed: true, running: true, healthy: true, binaryMatches: true, ...s }) as never;
function record(ctx: Ctx, records: Record<string, FileChange[]>) {
  writeManifest(ctx, { version: 1, planners: Object.fromEntries(Object.entries(records).map(([planner, files]) => [planner, {
    planner, installedAt: ctx.now, pacerArgv: ["pacer"], files, commands: [], notes: [],
  }])) });
}
function find(checks: Check[], name: string): Check {
  const result = checks.find(c => c.name === name);
  expect(result).toBeDefined();
  return result!;
}
function intactFile(ctx: Ctx, relative: string): FileChange {
  const path = join(ctx.home, relative);
  put(path, "policy");
  return { path, action: "created", afterHash: sha256("policy"), undo: [] };
}

test("usage remedies: stale and unknown refresh, auth signs in, payment opens billing with a turn-off", async () => {
  const ctx = fixture();
  const checks = await runDoctor(ctx, { service: service(), status: async () => status({ "claude-code": { stale: true }, codex: { verdict: "UNKNOWN" } }) });
  expect(find(checks, "Usage claude-code").remedy).toEqual({ kind: "auto", label: "Refresh usage", op: "limits.refresh", params: { account: "claude-code" } });
  expect(find(checks, "Usage codex").remedy).toMatchObject({ kind: "auto", op: "limits.refresh", params: { account: "codex" } });

  const auth = await runDoctor(ctx, { service: service(), status: async () => status({
    "claude-code": { error: "401 unauthorized", eligibility: { state: "ineligible", reasons: [{ code: "authentication_failed", evidenceIds: [] }] } as never },
    codex: { stale: true, signedOutReason: "codex auth expired" },
  }) });
  expect(find(auth, "Usage claude-code").remedy).toMatchObject({ kind: "user", op: "account.signin", params: { name: "claude-code" } });
  expect(find(auth, "Usage codex").remedy).toMatchObject({ kind: "user", op: "account.signin", params: { name: "codex" } });

  const payment = await runDoctor(ctx, { service: service(), status: async () => status({
    codex: { error: "no plan", eligibility: { state: "ineligible", reasons: [{ code: "subscription_missing", evidenceIds: [] }] } as never },
  }) });
  expect(find(payment, "Usage codex").remedy).toEqual({
    kind: "user", label: "Open Codex billing", url: "https://chatgpt.com/#pricing",
    secondary: { label: "Turn off Codex", op: "runner.block", params: { id: "codex", reason: "No active subscription" } },
  });
});

test("login, service, binary, CLI and unmatched warnings get user, auto and agent remedies", async () => {
  const ctx = fixture();
  ctx.which = bin => bin === "codex" ? null : `/fake/${bin}`;
  let checks = await runDoctor(ctx, { status: async () => status(), service: service({ installed: false, running: false, healthy: false, binaryMatches: false }) });
  expect(find(checks, "Login claude-code").remedy).toEqual({ kind: "user", label: "Sign in to Claude", op: "account.signin", params: { name: "claude-code" } });
  expect(find(checks, "Service").remedy).toEqual({ kind: "auto", label: "Install service", op: "service.install" });
  expect(find(checks, "Binary codex").remedy).toEqual({ kind: "agent", label: "Fix with agent", op: "doctor.fix.delegate", params: { check: "Binary codex", scope: "fix" } });
  expect(find(checks, "Orca").remedy).toMatchObject({ kind: "agent", op: "doctor.fix.delegate", params: { check: "Orca" } });

  ctx.which = bin => `/fake/${bin}`;
  checks = await runDoctor(ctx, { status: async () => status(), service: service({ running: false, healthy: false }) });
  expect(find(checks, "Service").remedy).toEqual({ kind: "auto", label: "Restart service", op: "service.install" });
  expect(find(checks, "CLI codex")).toMatchObject({ level: "fail", remedy: { kind: "agent", params: { check: "CLI codex" } } });
});

test("integration files: auto for pacer-managed refresh, review for any connected agent, agent for unaddressable targets", async () => {
  const ctx = fixture();
  const skill = intactFile(ctx, ".codex/skills/pacer/SKILL.md");
  record(ctx, { codex: [intactFile(ctx, ".codex/AGENTS.md"), skill] });
  let checks = await runDoctor(ctx, { status: async () => status(), service: service() });
  expect(find(checks, "Integration freshness codex").remedy).toEqual({ kind: "auto", label: "Update files", op: "agent.connect", params: { agent: "codex" } });

  // A user-edited file turns the same refresh into a reviewed change; codex is not the selected planner.
  put(join(ctx.home, ".codex/AGENTS.md"), "user edits");
  put(skill.path, "user edits");
  checks = await runDoctor(ctx, { status: async () => status(), service: service() });
  for (const name of ["Integration freshness codex", "Install codex", "Skill codex"])
    expect(find(checks, name).remedy).toEqual({ kind: "review", label: "Review and fix", op: "agent.preview", params: { agent: "codex" } });

  // agent.connect cannot address a non-planner named account, so that target goes to an agent task.
  record(ctx, { "codex#work": [{ path: join(ctx.home, "missing"), action: "created", undo: [] }] });
  checks = await runDoctor(ctx, { status: async () => status(), service: service() });
  expect(find(checks, "Install codex#work").remedy).toMatchObject({ kind: "agent", params: { check: "Install codex#work" } });

  record(ctx, { service: [{ path: join(ctx.home, "missing"), action: "created", undo: [] }] });
  checks = await runDoctor(ctx, { status: async () => status(), service: service() });
  expect(find(checks, "Install service").remedy).toEqual({ kind: "auto", label: "Install service", op: "service.install" });
});

test("Claude hook configuration and the legacy guard are reviewed reconnects of claude-code", async () => {
  const ctx = fixture();
  record(ctx, { "claude-code": [] });
  put(join(ctx.home, ".claude/scripts/budget/subagent_guard.py"), "legacy");
  const checks = await runDoctor(ctx, { status: async () => status(), service: service() });
  const review = { kind: "review", label: "Review and fix", op: "agent.preview", params: { agent: "claude-code" } };
  expect(find(checks, "Claude hook configuration")).toMatchObject({ level: "warn", remedy: review });
  expect(find(checks, "Claude message hooks")).toMatchObject({ level: "warn", remedy: review });
  expect(find(checks, "Legacy guard")).toMatchObject({ fix: "pacer install claude-code migrates it", remedy: review });
});

test("pacer-internal error codes are warnings pacer could not check, classified by code and never a reinstall", async () => {
  const ctx = fixture();
  let checks = await runDoctor(ctx, { service: service(), status: async () => status({
    codex: { error: "CoreError: native process owner supervises plugin children", errorCode: "plugin_unavailable" },
    "claude-code": { error: "plugin_unavailable: looks internal but has no code" },
  }) });
  const internal = { kind: "internal" as const, label: "Restart pacer service", op: "service.install" };
  expect(find(checks, "Usage codex")).toEqual({ name: "Usage codex", level: "warn", evidence: "unverified",
    detail: "CoreError: native process owner supervises plugin children", remedy: internal });
  expect(find(checks, "Usage claude-code").remedy?.kind).toBe("agent");

  checks = await runDoctor(ctx, { service: service(), status: async () => status({
    codex: { error: "plugin_unavailable; 401 unauthorized", errorCode: "plugin_unavailable", signedOutReason: "codex auth expired" },
  }) });
  expect(find(checks, "Usage codex")).toMatchObject({ level: "warn", remedy: { kind: "user", op: "account.signin" } });

  for (const code of ["plugin_unavailable", "plugin_timeout"] as const) {
    checks = await runDoctor(ctx, { service: service(), status: async () => { throw new CoreError(code, "plugin call failed"); } });
    for (const name of ["Usage claude-code", "Usage codex"]) {
      const check = find(checks, name);
      expect(check).toMatchObject({ level: "warn", evidence: "unverified", remedy: internal });
      expect(check.fix).toBeUndefined();
    }
  }
  checks = await runDoctor(ctx, { service: service(), status: async () => { throw new Error("plugin_unavailable: message text only"); } });
  expect(find(checks, "Usage codex").remedy?.kind).toBe("agent");

  expect([...["plugin_unavailable", "plugin_timeout", "plugin_refused", "unknown_plugin"].map(isInternalCode), isInternalCode("invalid_input"), isInternalCode(undefined)])
    .toEqual([true, true, true, true, false, false]);
  expect(internalErrorCode(new CoreError("plugin_timeout", "deadline"))).toBe("plugin_timeout");
  expect(internalErrorCode(new CoreError("not_found", "plugin_unavailable"))).toBeUndefined();
  expect(internalErrorCode(new Error("plugin_unavailable"))).toBeUndefined();
  expect(internalCheck({ name: "Planner check codex", detail: "x" })).toEqual({ name: "Planner check codex", level: "warn", evidence: "unverified", detail: "x", remedy: internal });
});

test("only warnings and failures carry exactly one remedy", async () => {
  expect(withRemedies([
    { name: "A", level: "ok", detail: "", remedy: remedies.internal() },
    { name: "B", level: "info", detail: "" },
    { name: "C", level: "warn", detail: "" },
    { name: "D", level: "fail", detail: "", remedy: remedies.review("codex") },
  ])).toEqual([
    { name: "A", level: "ok", detail: "" },
    { name: "B", level: "info", detail: "" },
    { name: "C", level: "warn", detail: "", remedy: remedies.agent("C") },
    { name: "D", level: "fail", detail: "", remedy: remedies.review("codex") },
  ]);
  const ctx = fixture();
  ctx.which = bin => bin === "codex" ? null : `/fake/${bin}`;
  record(ctx, { "claude-code": [], codex: [intactFile(ctx, ".codex/AGENTS.md")] });
  for (const check of await runDoctor(ctx, { status: async () => status({ codex: { stale: true } }), service: service({ running: false }) }))
    expect(!!check.remedy).toBe(check.level === "warn" || check.level === "fail");
});

test("every operation a remedy can name is registered and accepts the remedy's params", async () => {
  const ctx = fixture();
  ctx.which = bin => bin === "codex" ? null : `/fake/${bin}`;
  record(ctx, { "claude-code": [], codex: [intactFile(ctx, ".codex/AGENTS.md")], service: [{ path: join(ctx.home, "missing"), action: "created", undo: [] }] });
  put(join(ctx.home, ".claude/scripts/budget/subagent_guard.py"), "legacy");
  const emitted: Remedy[] = [];
  for (const s of [status({ codex: { stale: true } }), status({ codex: { signedOutReason: "x", stale: true }, "claude-code": { error: "e", eligibility: { state: "ineligible", reasons: [{ code: "subscription_missing", evidenceIds: [] }] } as never } })])
    emitted.push(...(await runDoctor(ctx, { status: async () => s, service: service({ installed: false }) })).flatMap(c => c.remedy ? [c.remedy] : []));
  emitted.push(remedies.refreshUsage("a"), remedies.signIn("a", "A"), remedies.billing("claude", "r", "R"), remedies.billing("endpoint", "r", "R"),
    remedies.updateFiles("codex"), remedies.review("cursor"), remedies.service("Install service"), remedies.privacySettings(),
    remedies.agent("Orca"), remedies.internal());
  expect(new Set(emitted.map(r => r.kind))).toEqual(new Set(["auto", "review", "user", "agent", "internal"]));
  for (const remedy of emitted) {
    for (const action of [remedy, ...(remedy.secondary ? [remedy.secondary] : [])]) {
      expect(action.op !== undefined || action.url !== undefined).toBe(true);
      if (action.url) expect(action.url).toMatch(/^(https:|x-apple\.systempreferences:)/);
      if (!action.op) continue;
      expect(Object.hasOwn(OPS, action.op)).toBe(true);
      expect(action.params?.consent).toBeUndefined();
      // Consent comes from the person's click at call time; the remedy's own params must otherwise validate.
      const parsed = OPS[action.op]!.params.safeParse({ ...action.params, ...(action.op === "service.install" ? { consent: true } : {}) });
      expect(parsed.success).toBe(true);
    }
  }
});

test("pacer doctor prints each remedy's CLI equivalent where one exists", () => {
  expect(renderDoctor([
    { name: "Usage codex", level: "warn", detail: "stale usage", remedy: remedies.refreshUsage("codex") },
    { name: "Service", level: "warn", detail: "installed: false", fix: "pacer service install", remedy: remedies.service("Install service") },
    { name: "Install codex", level: "warn", detail: "changed", fix: "pacer install codex", remedy: remedies.review("codex") },
    { name: "Orca", level: "warn", detail: "tasks use the direct backend", remedy: remedies.agent("Orca") },
    { name: "Removable volume access", level: "warn", detail: "denied", remedy: remedies.privacySettings() },
  ])).toBe([
    "[warn] Usage codex: stale usage\n  run: pacer limits refresh codex\n",
    "[warn] Service: installed: false\n  fix: pacer service install\n",
    "[warn] Install codex: changed\n  fix: pacer install codex\n",
    `[warn] Orca: tasks use the direct backend\n  run: pacer api call doctor.fix.delegate --params '{"check":"Orca","scope":"fix"}'\n`,
    "[warn] Removable volume access: denied\n  run: open 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'\n",
  ].join(""));
  expect(remedyCommand(remedies.billing("codex", "codex#work", "Codex (work)").secondary as Remedy)).toBe("pacer executor block codex#work");
  expect(remedyCommand(remedies.signIn("work", "Codex"))).toBe(`pacer api call account.signin --params '{"name":"work"}'`);
  expect(remedyCommand({ kind: "user", label: "x" })).toBeUndefined();
  expect(remedyCommand(remedies.internal())).toBe("pacer service restart");
});
