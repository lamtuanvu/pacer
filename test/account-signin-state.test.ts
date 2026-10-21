// Regression tests: one local sign-in truth for account list, routing, capacity, attention and runner checks.
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { list } from "../src/core/accounts";
import { checkRunner } from "../src/core/runner-check";
import { loadStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { buildAccounts, buildExecutors } from "../src/api/read-model/capacity";
import { deriveItems } from "../src/attention/rules";
import { fakeCtx } from "./helpers";
import { markAuthFailed } from "../src/usage/auth";
import { accountEvidenceScope } from "../src/evidence/scope";

function setup() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  const work = join(ctx.home, ".claude-work"), off = join(ctx.home, ".claude-off");
  mkdirSync(work, {recursive: true}); mkdirSync(off, {recursive: true});
  writeFileSync(join(work, ".claude.json"), JSON.stringify({oauthAccount: {accountUuid: "x"}, numStartups: 3}));
  writeFileSync(join(off, ".claude.json"), JSON.stringify({numStartups: 1}));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
    planner: "codex",
    accounts: {codex: {kind: "codex"}, work: {kind: "claude", home: work}, off: {kind: "claude", home: off}, local: {kind: "endpoint", usage: "unmetered", model: "local/m"}},
    runners: {codex: {}, "claude-code#work": {}, "claude-code#off": {}, "opencode#local": {}},
    routing: [{default: ["claude-code#work", "claude-code#off", "opencode#local"]}],
  }));
  return {ctx, work, off};
}

test("account list reports local native sign-in from the login indicator and no sign-in for endpoints", async () => {
  const {ctx} = setup();
  const rows = await list(ctx);
  const row = (name: string) => rows.find(r => r.name === name)!;
  expect(row("work").signedIn).toBe(true);
  expect(row("work").signin_command).toBeUndefined();
  expect(row("off").signedIn).toBe(false);
  expect(row("off").signin_command).toContain("claude");
  expect(row("local").signedIn).toBeNull();
  expect(row("local").signin_command).toBeUndefined();
  expect(row("local").state).toBe("external");
});

test("a recorded authentication failure signs an account out until it signs in again", async () => {
  const {ctx, work} = setup();
  mkdirSync(join(ctx.pacerHome, "state"), {recursive: true});
  const strategy = loadStrategy(ctx);
  markAuthFailed(ctx, "work", "authentication failed", {scope: accountEvidenceScope(strategy.accounts.work!, strategy.hosts)});
  const old = (ctx.now - 600);
  utimesSync(join(work, ".claude.json"), old, old);
  expect((await list(ctx)).find(r => r.name === "work")!.signedIn).toBe(false);
  // Logging in again rewrites the config file after the failure.
  utimesSync(join(work, ".claude.json"), ctx.now + 60, ctx.now + 60);
  ctx.now += 61;
  expect((await list(ctx)).find(r => r.name === "work")!.signedIn).toBe(true);
});

test("route, capacity rows and account summaries agree on a signed-out executor", async () => {
  const {ctx} = setup();
  const s = loadStrategy(ctx), st = await computeStatus(ctx, s);
  expect(st.executors.excluded.find(e => e.id === "claude-code#off")?.reason).toBe("signed out — run claude and log in");
  expect(st.executors.ranked.some(e => e.id === "claude-code#work")).toBe(true);
  const rows = buildExecutors(st, s, [], ctx.now, ctx);
  const off = rows.find(r => r.id === "claude-code#off")!;
  expect(off.state).not.toBe("ready");
  expect(off.reason).toContain("signed out");
  expect(rows.find(r => r.id === "claude-code#work")!.state).toBe("ready");
  const accounts = buildAccounts(st, s, ctx);
  expect(accounts.find(a => a.name === "off")!.signedIn).toBe(false);
  expect(accounts.find(a => a.name === "work")!.signedIn).toBe(true);
  expect(accounts.find(a => a.name === "local")!.signedIn).toBeNull();
  const items = deriveItems({now: ctx.now, tasks: [], executors: rows, accounts, planner: null, setup: {items: []} as never, update: null, retryTarget: () => null});
  expect(items.map(i => i.id)).toContain("account_signin:off");
  // The sign-in item already covers it; no second "not working" item for the same cause.
  expect(items.map(i => i.id)).not.toContain("executor_down:claude-code#off");
});

test("runner check: a signed-in Claude account without status-line data passes and runs the test task", async () => {
  const {ctx} = setup(); let launched = false;
  const job = await checkRunner(ctx, "claude-code#work", {
    detectAgents: async () => [{agent: "claude-code", found: true, version: "1", path: "/bin/claude", install_hint: "install"}],
    runTestTask: async () => { launched = true; },
  });
  expect(job.steps[1]).toMatchObject({name: "Signed in", state: "passed"});
  expect(job.steps[2]).toMatchObject({name: "Usage readable", state: "skipped"});
  expect(job.steps[2].detail).toContain("status line");
  expect(launched).toBe(true);
  expect(job.state).toBe("passed");
});

test("runner check: a signed-out Claude account fails at Signed in with the fix", async () => {
  const {ctx} = setup(); let launched = false;
  const job = await checkRunner(ctx, "claude-code#off", {
    detectAgents: async () => [{agent: "claude-code", found: true, version: "1", path: "/bin/claude", install_hint: "install"}],
    runTestTask: async () => { launched = true; },
  });
  expect(job.state).toBe("failed");
  expect(job.steps[1]).toMatchObject({name: "Signed in", state: "failed"});
  expect(job.steps[1].detail).toContain("run claude and log in");
  expect(launched).toBe(false);
});

test("account status vocabulary: endpoint state for endpoints, sign-in for native accounts", async () => {
  const {accountStatus, accountNeedsSignIn} = await import("../src/view-model/words");
  expect(accountStatus({kind: "endpoint", signedIn: null, state: "ready"}).label).toBe("Ready");
  expect(accountStatus({kind: "endpoint", signedIn: null, state: "not_tested"}).label).toBe("Not tested");
  expect(accountStatus({kind: "endpoint", signedIn: null, state: "not_working"}).label).toBe("Not working");
  expect(accountStatus({kind: "endpoint", signedIn: null, state: "key_missing"}).label).toBe("Key missing");
  expect(accountStatus({kind: "claude", signedIn: true}).label).toBe("Signed in");
  expect(accountStatus({kind: "claude", signedIn: false}).label).toBe("Signed out");
  expect(accountStatus({kind: "claude", signedIn: null}).label).toBe("Unknown");
  expect(accountNeedsSignIn({kind: "endpoint", signedIn: false})).toBe(false);
  expect(accountNeedsSignIn({kind: "claude", signedIn: null})).toBe(false);
  expect(accountNeedsSignIn({kind: "claude", signedIn: false})).toBe(true);
});

test("decision: a failed runner check keeps the executor in routing (attention only)", async () => {
  const {ctx} = setup();
  mkdirSync(join(ctx.pacerHome, "state"), {recursive: true});
  writeFileSync(join(ctx.pacerHome, "state", "runner-checks.json"), JSON.stringify({"claude-code#work": {at: ctx.now, passed: false, detail: "Test task failed"}}));
  const s = loadStrategy(ctx), st = await computeStatus(ctx, s);
  expect(st.executors.ranked.some(e => e.id === "claude-code#work")).toBe(true);
  const rows = buildExecutors(st, s, [], ctx.now, ctx);
  expect(rows.find(r => r.id === "claude-code#work")!.state).toBe("failing");
});

test("routing excludes an executor whose authentication failed after its last login, and ranks it after a newer login", async () => {
  const {ctx, work} = setup();
  mkdirSync(join(ctx.pacerHome, "state"), {recursive: true});
  const strategy = loadStrategy(ctx);
  markAuthFailed(ctx, "work", "authentication failed", {scope: accountEvidenceScope(strategy.accounts.work!, strategy.hosts)});
  // The failure is newer than the login file: excluded with the authentication reason.
  utimesSync(join(work, ".claude.json"), ctx.now - 600, ctx.now - 600);
  let st = await computeStatus(ctx, loadStrategy(ctx));
  expect(st.executors.excluded.find(e => e.id === "claude-code#work")?.reason).toBe("signed out — authentication failed; run claude and log in");
  expect(st.executors.ranked.some(e => e.id === "claude-code#work")).toBe(false);
  // Logging in again rewrites the login file after the failure: ranked again.
  utimesSync(join(work, ".claude.json"), ctx.now + 60, ctx.now + 60);
  ctx.now += 61;
  st = await computeStatus(ctx, loadStrategy(ctx));
  expect(st.executors.ranked.some(e => e.id === "claude-code#work")).toBe(true);
  expect(st.executors.excluded.some(e => e.id === "claude-code#work")).toBe(false);
});

test("a not-tested endpoint executor stays routable but is not shown as Ready", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
    planner: "codex",
    accounts: {codex: {kind: "codex"}, lab: {kind: "endpoint", usage: "unmetered", connection: {api: "openai-compatible", base_url: "http://127.0.0.1:9/v1", key: "none", models: [{id: "m", context: 128000, output: 16000, tools: true}]}}},
    runners: {codex: {}, "opencode#lab": {model: "pacer-lab/m"}},
    routing: [{default: ["opencode#lab"]}],
  }));
  const {executorRowStatus} = await import("../src/view-model/words") as typeof import("../src/view-model/words") & {executorRowStatus: (row: {state: string; untested?: boolean}) => {label: string; tone: string}};
  const s = loadStrategy(ctx);
  let st = await computeStatus(ctx, s);
  // Spec (endpoint executors §5): routing excludes only Not working and Key missing.
  expect(st.executors.ranked.some(e => e.id === "opencode#lab")).toBe(true);
  let row = buildExecutors(st, s, [], ctx.now, ctx).find(r => r.id === "opencode#lab")! as ReturnType<typeof buildExecutors>[number] & {untested?: boolean};
  expect(row.untested).toBe(true);
  expect(row.reason).toBe("not tested — run a check");
  expect(executorRowStatus(row)).toMatchObject({label: "Not tested", tone: "neutral"});
  const {writeEndpointState} = await import("../src/endpoints/state");
  writeEndpointState(ctx, "lab", {state: "ready", checked_at: new Date().toISOString()});
  st = await computeStatus(ctx, s);
  row = buildExecutors(st, s, [], ctx.now, ctx).find(r => r.id === "opencode#lab")!;
  expect(row.untested).toBeUndefined();
  expect(executorRowStatus(row).label).toBe("Ready");
});


test("unbound legacy authentication marks do not sign out a current account identity", async () => {
  const {ctx, work} = setup();
  mkdirSync(join(ctx.pacerHome, "state"), {recursive: true});
  writeFileSync(join(ctx.pacerHome, "state", "auth-failed.json"), JSON.stringify({work: ctx.now}));
  utimesSync(join(work, ".claude.json"), ctx.now - 600, ctx.now - 600);
  expect((await list(ctx)).find(r => r.name === "work")!.signedIn).toBe(true);
  const st = await computeStatus(ctx, loadStrategy(ctx));
  expect(st.executors.ranked.some(e => e.id === "claude-code#work")).toBe(true);
});

for (const clearSidecar of [false, true]) {
  test(`new local login recovers scoped execution authentication (${clearSidecar ? "persisted only" : "with sidecar"})`, async () => {
    const {ctx, work} = setup(), strategy = loadStrategy(ctx);
    const {recordExecutionEvidence, readEvidence} = await import("../src/core/evidence");
    const {recordAuthReading} = await import("../src/usage/auth");
    const scope = {...accountEvidenceScope(strategy.accounts.work!, strategy.hosts), runner: "claude-code#work", model: "default", host: "local"};
    const failedAt = ctx.now;
    await recordExecutionEvidence(ctx, scope, {endedAt: failedAt, exitCode: 1, timedOut: false, classification: "authentication"});
    const remote = {...scope, host: "remote"};
    await recordExecutionEvidence(ctx, remote, {endedAt: failedAt, exitCode: 1, timedOut: false, classification: "authentication"});
    markAuthFailed(ctx, "work", "authentication failed", {scope});
    utimesSync(join(work, ".claude.json"), failedAt - 600, failedAt - 600);
    if (clearSidecar) {
      ctx.now += 10;
      recordAuthReading(ctx, "work", {capturedAt: ctx.now, windows: [], stale: false, source: "session-log"}, scope);
    }
    expect((await computeStatus(ctx, strategy)).executors.ranked.some(e => e.id === scope.runner)).toBe(false);
    utimesSync(join(work, ".claude.json"), failedAt + 60, failedAt + 60);
    ctx.now = failedAt + 61;
    expect((await computeStatus(ctx, strategy)).executors.ranked.some(e => e.id === scope.runner)).toBe(true);
    const facts = readEvidence(ctx, scope).evidence.facts.availability;
    expect(facts.find(f => f.scope.host === "local")).toMatchObject({value: "ready", scope, observedAt: failedAt + 60});
    expect(facts.find(f => f.scope.host === "remote")).toMatchObject({value: "unavailable", scope: remote});
  });
}

test("successful same-scope execution supersedes its older auth sidecar without rewriting login", async () => {
  const {ctx, work} = setup(), strategy = loadStrategy(ctx);
  const {recordExecutionEvidence} = await import("../src/core/evidence");
  const scope = {...accountEvidenceScope(strategy.accounts.work!, strategy.hosts), runner: "claude-code#work", model: "default", host: "local"};
  utimesSync(join(work, ".claude.json"), ctx.now - 600, ctx.now - 600);
  markAuthFailed(ctx, "work", "authentication failed", {scope});
  await recordExecutionEvidence(ctx, scope, {endedAt: ctx.now, exitCode: 1, timedOut: false, classification: "authentication"});
  ctx.now += 10;
  await recordExecutionEvidence(ctx, scope, {endedAt: ctx.now, exitCode: 0, timedOut: false, classification: "success"});
  expect((await computeStatus(ctx, strategy)).executors.ranked.some(e => e.id === scope.runner)).toBe(true);
});
