import { afterAll } from "bun:test";
import { cleanupTestTmp, fakeCtx, localTs } from "./helpers";
import { mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync, appendFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import type { AccountEvidence, Evidence, EvidenceScope } from "../src/evidence/types";
import type { Ctx, UsageKind, UsageReading, UsageSource, UsageWindow } from "../src/types";
import { markFreshness } from "../src/usage/freshness";
import { emptyEvidence, evidenceFact, readingEvidence, reconcileEvidence } from "../src/engine/evidence";
import { writeUsageEntry } from "../src/usage/store";
import { recordAuthReading, authObservation } from "../src/usage/auth";
import { activeLimitObservations } from "../src/usage/reactive";
import { accountSignIn } from "../src/usage/signin";
import { cachedRemoteUsage } from "../src/remote/usage";
import { endpointRow } from "../src/endpoints/row";
import { accountEvidenceScope } from "../src/evidence/scope";
import { buildActivity, loadActivity } from "../src/pace/activity";
import { readJson } from "../src/fsutil";

// The Rust pacer-status crate replays these recordings against its own
// freshness::mark_freshness, evidence ports and usage store (crates/status/
// tests/goldens.rs). Re-record with UPDATE_M3_GOLDENS=1 after changing
// TypeScript; a plain run must stay green against the committed fixtures.

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "m3", "status");
const SCOPE: EvidenceScope = { account: "one", identity: "a".repeat(64) };
const ID = "a".repeat(64);
const NOW = 1_000_000;

type Case = { name: string; input: unknown; expected: unknown };
let cases: Case[] = [];

const record = async (module: string): Promise<void> => {
  for (const c of cases) c.expected = await c.expected;
  const text = JSON.stringify(cases, null, 2) + "\n";
  if (process.env.UPDATE_M3_GOLDENS === "1") {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(join(FIXTURE_DIR, `${module}.json`), text);
  }
  expect(JSON.parse(readFileSync(join(FIXTURE_DIR, `${module}.json`), "utf8"))).toEqual(cases);
};

afterAll(cleanupTestTmp);

test("markFreshness goldens match the TypeScript freshness rules", async () => {
  cases = [];
  const reading = (over: Partial<UsageReading> = {}): UsageReading =>
    ({ windows: [], capturedAt: NOW, stale: false, ...over }) as UsageReading;
  const window = (name: string, over: Record<string, unknown> = {}) =>
    ({ name, usedPct: null, resetsAt: null, lengthS: 18000, paced: false, ...over });
  // A fresh quota reading with 5h/7d windows stays fresh.
  recordCase("fresh", { reading: reading({ windows: [
    window("5h", { usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000 }),
    window("7d", { usedPct: 10, resetsAt: null, lengthS: 604800 }),
  ], capturedAt: NOW - 100 }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // Past the 5h cap the short window turns stale while a 7d window stays fresh.
  recordCase("short-window-stale", { reading: reading({ windows: [
    window("5h", { usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000 }),
    window("7d", { usedPct: 10, resetsAt: null, lengthS: 604800 }),
  ], capturedAt: NOW - 7200 }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // A future capturedAt is stale.
  recordCase("future-capturedAt", { reading: reading({ windows: [
    window("5h", { usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000 }),
  ], capturedAt: NOW + 3600 }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // A null capturedAt is stale.
  recordCase("null-capturedAt", { reading: reading({ windows: [
    window("5h", { usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000 }),
  ], capturedAt: null }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // A reactive limit window whose resetsAt has passed is stale.
  recordCase("reactive-limit-reset", { reading: reading({ source: "reactive", windows: [
    window("limit", { usedPct: 100, resetsAt: NOW, lengthS: 18000 }),
  ] }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  // An unmetered reading with no windows keeps its own stale flag.
  recordCase("unmetered-stale-true", { reading: reading({ source: "unmetered", stale: true }), now: NOW },
    (i: any) => markFreshness(i.reading, i.now));
  // A limit window on a non-contract source ignores the old capturedAt.
  recordCase("non-contract-limit", { reading: reading({ source: "status-line", windows: [
    window("limit", { usedPct: 100, resetsAt: null, lengthS: 18000 }),
  ], capturedAt: NOW - 100000 }), now: NOW }, (i: any) => markFreshness(i.reading, i.now));
  await record("freshness");
});

test("evidence goldens match the TypeScript evidence functions", async () => {
  cases = [];
  // evidenceFact ids pin the JavaScript number spelling (integer, fractional, 1e21, null).
  factCase("int", { source: "provider-cli", observedAt: NOW, validUntil: null, reason: "quota_observed",
    value: { name: "weekly", usedPct: 15, resetsAt: NOW + 604800, lengthS: 604800, paced: true } });
  factCase("fractional", { source: "provider-cli", observedAt: NOW, validUntil: null, reason: "quota_observed",
    value: { name: "weekly", usedPct: 0.1 + 0.2, resetsAt: NOW + 604800, lengthS: 604800, paced: true } });
  factCase("1e21", { source: "provider-cli", observedAt: NOW, validUntil: null, reason: "quota_observed",
    value: { name: "weekly", usedPct: 1e21, resetsAt: NOW + 604800, lengthS: 604800, paced: true } });
  factCase("null-value", { source: "provider-cli", observedAt: null, validUntil: null, reason: "quota_observed", value: null });
  factCase("budget-policy", { source: "provider-cli", observedAt: NOW, validUntil: null, reason: "quota_observed",
    value: { name: "weekly", usedPct: 15, resetsAt: NOW + 604800, lengthS: 604800, paced: true }, budgetPolicy: "model.fast" });

  const qr = (windows: any[], over: Partial<UsageReading> = {}): UsageReading =>
    ({ windows, capturedAt: NOW, stale: false, ...over }) as UsageReading;
  const w5 = { name: "5h", usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000, paced: false };
  const w7 = { name: "7d", usedPct: 10, resetsAt: null, lengthS: 604800, paced: true };
  // 1: a quota reading with two windows.
  readingCase("quota-windows", "quota", qr([w5, w7]));
  // 2: a reactive reading with limit at usedPct 0 is skipped.
  readingCase("reactive-limit-skipped", "reactive", qr([{ ...w5, name: "limit", usedPct: 0, resetsAt: null }], { source: "reactive" }));
  // 3: an availability reading.
  readingCase("availability", "quota", qr([w5], { source: "status-line",
    availability: { state: "ready", reason: "usage_observed", validUntil: NOW + 7200 } }));
  // 4: a metered reading with spendUsd only.
  readingCase("metered-spend", "metered", qr([], { source: "metered", spendUsd: 12.4,
    spending: { creditsAvailable: true, creditBalance: null, paidConsumption: "observed" } }));
  // 5: a reading with error gets no usage_observed.
  readingCase("error-no-usage", "quota", qr([], { source: "status-line", capturedAt: null, stale: true, error: "down" }));
  // 6: alternatives with one remote reading.
  readingCase("alternatives", "quota", qr([w5], {
    alternatives: [{ windows: [{ name: "5h", usedPct: 30, resetsAt: NOW + 3600, lengthS: 18000, paced: false }], capturedAt: NOW, stale: false, source: "session-log" as const }],
  }));
  // 7: reading.evidence given, returned as is.
  const given = emptyEvidence() as AccountEvidence;
  given.budget.push(fact("given" as any, NOW, "quota_observed", { name: "weekly", usedPct: 15, resetsAt: NOW + 604800, lengthS: 604800, paced: true }) as Evidence<UsageWindow>);
  readingCase("given-evidence", "quota", qr([], { evidence: given }));

  const budgetOf = (f: { budget: Evidence<unknown>[] }) => ({ ...emptyEvidence(), budget: f.budget } as AccountEvidence);
  const accept = (f: AccountEvidence) => f;
  // 1: newest-observation wins.
  reconcileCase("newest-observation", budgetOf({ budget: [fact("provider-cli", NOW - 100, "quota_observed", w5)] }),
    budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w5)] }), NOW);
  // 2: configuration beats provider-cli at equal time.
  reconcileCase("config-beats-provider-cli", budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w5)] }),
    budgetOf({ budget: [fact("configuration", NOW, "config_limit", { ...w5, name: "5h", usedPct: 90 })] }), NOW);
  // 3: equal-authority different values become a conflict.
  reconcileCase("equal-authority-conflict", budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w5)] }),
    budgetOf({ budget: [fact("session-log", NOW, "quota_observed", { ...w5, usedPct: 35 })] }), NOW);
  // 4: the Codex 0h artifact is retired by a newer same-budgetPolicy witness.
  reconcileCase("zero-hour-retired", budgetOf({ budget: [fact("session-log", NOW - 86400, "quota_observed",
    { name: "0h", usedPct: null, resetsAt: null, lengthS: 0, paced: false })] }),
    budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w7)] }), NOW);
  // 5: a newer under-97 measurement drops an older execution limit.
  reconcileCase("newer-measurement-drops-execution-limit", budgetOf({ budget: [fact("execution", NOW - 7200, "quota_failure",
    { name: "limit", usedPct: 100, resetsAt: NOW + 7200, lengthS: 21600, paced: false })] }),
    budgetOf({ budget: [fact("provider-cli", NOW, "quota_observed", w7), fact("session-log", NOW, "quota_observed", { ...w7, usedPct: 30 })] }), NOW);
  // 6: an expired cooldown limit is dropped.
  reconcileCase("expired-cooldown", budgetOf({ budget: [fact("execution", NOW - 86400, "quota_failure",
    { name: "limit", usedPct: 100, resetsAt: NOW - 100, lengthS: 21600, paced: false })] }),
    accept(emptyEvidence()), NOW);
  // 7: an omitted lapsed window is retired by a newer same-source witness.
  reconcileCase("omitted-lapsed-window-retired", budgetOf({ budget: [fact("status-line", NOW - 20000, "quota_observed",
    { name: "5h", usedPct: 14, resetsAt: NOW - 1000, lengthS: 18000, paced: false })] }),
    budgetOf({ budget: [fact("status-line", NOW, "quota_observed", w7)] }), NOW);
  // 8: availability with validUntil older than 7 days is pruned.
  reconcileCase("availability-pruned", { ...emptyEvidence(), availability: [fact("execution", NOW - 30 * 86400, "execution_success", "ready")] } as AccountEvidence,
    accept(emptyEvidence()), NOW);
  // 9: conflict ids are sorted and dropped when the fact is gone.
  reconcileCase("conflict-sorted-dropped", budgetOf({ budget: [
    fact("provider-cli", NOW, "quota_observed", w5), fact("session-log", NOW, "quota_observed", { ...w5, usedPct: 35 }) ] }),
    accept(emptyEvidence()), NOW);
  await record("evidence");
});

test("usage-store goldens match the TypeScript write rule", async () => {
  cases = [];
  const reading = (pct: number, over: Partial<UsageReading> = {}): UsageReading =>
    ({ windows: [{ name: "weekly", usedPct: pct, resetsAt: null, lengthS: 604800, paced: true }], capturedAt: NOW, ...over }) as UsageReading;
  const filesBytes = (ctx: Ctx): string | null =>
    existsSync(join(ctx.pacerHome, "state", "usage", `${ID}.json`))
      ? readFileSync(join(ctx.pacerHome, "state", "usage", `${ID}.json`), "utf8") : null;
  const store = (name: string, readOnly: boolean, writes: { now: number; key: string; reading: UsageReading }[]): void => {
    cases.push({
      name: `usage-store:${name}`, input: { readOnly, writes },
      expected: (() => {
        const ctx = fakeCtx({ now: writes[0].now, readOnly });
        for (const w of writes) writeUsageEntry({ ...ctx, now: w.now }, ID, w.key, w.reading);
        const bytes = filesBytes(ctx);
        return { bytes };
      })(),
    });
  };
  // 1: first write.
  store("first-write", false, [{ now: NOW, key: "one", reading: reading(10) }]);
  // 2: an identical reading within the refresh-ahead window -> no rewrite (same bytes).
  store("no-rewrite-fresh", false, [
    { now: NOW, key: "one", reading: reading(10) },
    { now: NOW + 300, key: "one", reading: reading(10, { capturedAt: NOW + 300 }) },
  ]);
  // 3: the same shape shortly before it lapses -> rewrite.
  store("rewrite-before-lapse", false, [
    { now: NOW, key: "one", reading: reading(10, { windows: [{ name: "5h", usedPct: 10, resetsAt: null, lengthS: 18000, paced: false }] }) },
    { now: NOW + 6600, key: "one", reading: reading(10, { windows: [{ name: "5h", usedPct: 10, resetsAt: null, lengthS: 18000, paced: false }], capturedAt: NOW + 6600 }) },
  ]);
  // 4: a superseded key older than 7 days is pruned.
  store("superseded-key-pruned", false, [
    { now: NOW, key: "old-key", reading: reading(5) },
    { now: NOW + 8 * 86400, key: "one", reading: reading(30, { capturedAt: NOW + 8 * 86400 }) },
  ]);
  // 5: readOnly -> no file.
  store("readonly-no-file", true, [{ now: NOW, key: "one", reading: reading(10) }]);
  await record("usage-store");
});

// ---- B12-2 account-input goldens -------------------------------------------
// Each case records an `input` that deterministically rebuilds a fake pacer
// home (`files` keyed by path relative to home for `~/`, else pacerHome; `env`,
// `now`) plus the per-function arguments, and `expected` is the function's
// output (and/or the post-state of a written file). The Rust pacer-status
// crate replays the same fixtures against its ports (crates/status/
// tests/inputs.rs).

type FileSpec = { content: string; mtime?: number } | null;
function writeFiles(ctx: Ctx, files: Record<string, FileSpec>): void {
  for (const [rel, spec] of Object.entries(files)) {
    const path = rel.startsWith("~/") ? join(ctx.home, rel.slice(2)) : join(ctx.pacerHome, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    if (spec == null) { writeFileSync(path, ""); continue; }
    writeFileSync(path, spec.content);
    if (spec.mtime !== undefined) utimesSync(path, spec.mtime, spec.mtime);
  }
}
function fileBytes(ctx: Ctx, rel: string): string | null {
  const path = rel.startsWith("~/") ? join(ctx.home, rel.slice(2)) : join(ctx.pacerHome, rel);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
function accountCtx(input: any): Ctx {
  const ctx = fakeCtx({ now: input.now ?? NOW, env: input.env ?? {} });
  writeFiles(ctx, input.files ?? {});
  return ctx;
}

test("marks goldens match the TypeScript auth and limit-mark rules", async () => {
  cases = [];
  const scope = accountEvidenceScope({ name: "codex", kind: "codex", source: "native" } as any);
  const id = scope.identity;
  // 1: an observation with a matching identity and current `at` is returned.
  recordCase("auth-observation-ok", {
    now: NOW, files: {
      "state/auth-failed.json": { content: JSON.stringify({ codex: NOW - 10 }) },
      "state/auth-evidence.json": { content: JSON.stringify({ codex: { at: NOW - 10, scope } }) },
    }, scope, at: NOW - 10,
  }, (i: any) => authObservation(accountCtx(i), i.scope));
  // 2: a mismatched identity is ignored.
  const other = accountEvidenceScope({ name: "other", kind: "codex", source: "native" } as any);
  recordCase("auth-observation-mismatch", {
    now: NOW, files: {
      "state/auth-failed.json": { content: JSON.stringify({ codex: NOW - 10 }) },
      "state/auth-evidence.json": { content: JSON.stringify({ codex: { at: NOW - 10, scope: other } }) },
    }, scope, at: NOW - 10,
  }, (i: any) => authObservation(accountCtx(i), i.scope));
  // 3: an `at` older than the identity's retiredAt is null.
  recordCase("auth-observation-retired", {
    now: NOW, files: {
      "state/auth-failed.json": { content: JSON.stringify({ codex: NOW - 10 }) },
      "state/auth-evidence.json": { content: JSON.stringify({ codex: { at: NOW - 10, scope } }) },
      ["state/evidence/" + id + ".json"]: { content: JSON.stringify({ version: 1, revision: 0, identity: id, retiredAt: NOW - 1, evidence: { facts: emptyEvidence(), conflicts: [] } }) },
    }, scope, at: NOW - 10,
  }, (i: any) => authObservation(accountCtx(i), i.scope));
  // 4: recordAuthReading with a matching error marks the account failed.
  recordCase("record-auth-reading-error", {
    now: NOW, files: {}, scope: scope, account: "codex",
    reading: { windows: [], capturedAt: NOW, stale: false, error: "401 Unauthorized" },
  }, (i: any) => {
    const ctx = accountCtx(i);
    recordAuthReading(ctx, i.account, i.reading, i.scope);
    return { authFailed: fileBytes(ctx, "state/auth-failed.json") };
  });
  // 5: a newer successful reading deletes the mark.
  recordCase("record-auth-reading-clear", {
    now: NOW, files: { "state/auth-failed.json": { content: JSON.stringify({ codex: NOW - 10 }) } },
    scope: scope, account: "codex",
    reading: { windows: [], capturedAt: NOW, stale: false, source: "session-log" },
  }, (i: any) => {
    const ctx = accountCtx(i);
    recordAuthReading(ctx, i.account, i.reading, i.scope);
    return { authFailed: fileBytes(ctx, "state/auth-failed.json") };
  });
  // 6: a stale reading leaves the mark unchanged.
  recordCase("record-auth-reading-stale", {
    now: NOW, files: { "state/auth-failed.json": { content: JSON.stringify({ codex: NOW - 10 }) } },
    scope: scope, account: "codex",
    reading: { windows: [], capturedAt: NOW - 5, stale: true, source: "session-log" },
  }, (i: any) => {
    const ctx = accountCtx(i);
    recordAuthReading(ctx, i.account, i.reading, i.scope);
    return { authFailed: fileBytes(ctx, "state/auth-failed.json") };
  });
  // 7: active demand marks include ones without evidence and skip expired ones.
  const ev: any = { observedAt: NOW - 5, until: NOW + 100, manual: false, scope };
  recordCase("active-limit-observations", {
    now: NOW, files: {
      "exhausted.json": { content: JSON.stringify({ with: NOW + 100, without: NOW + 50, expired: NOW - 5 }) },
      "state/exhausted-evidence.json": { content: JSON.stringify({ with: ev }) },
    },
  }, (i: any) => {
    const ctx = accountCtx(i);
    return activeLimitObservations(ctx).map(x => ({ key: x.key, observation: x.observation }));
  });
  await record("marks");
});

test("signin goldens match the TypeScript local sign-in rule", async () => {
  cases = [];
  const codexScope = accountEvidenceScope({ name: "codex", kind: "codex", source: "native" } as any);
  const claudeScope = accountEvidenceScope({ name: "claude", kind: "claude", source: "native" } as any);
  // 1: a claude account with oauthAccount in its login file is signed in.
  recordCase("signin-claude-oauth", {
    now: NOW, env: {}, files: { "~/.claude.json": { content: JSON.stringify({ oauthAccount: { accountUuid: "x" } }), mtime: NOW - 60 } },
    account: { name: "claude", kind: "claude", source: "native" }, scope: claudeScope,
  }, (i: any) => accountSignIn(accountCtx(i), i.account, i.scope));
  // 2: without oauthAccount it is signed out with the claude fix.
  recordCase("signin-claude-out", {
    now: NOW, env: {}, files: { "~/.claude.json": { content: JSON.stringify({ numStartups: 1 }), mtime: NOW - 60 } },
    account: { name: "claude", kind: "claude", source: "native" }, scope: claudeScope,
  }, (i: any) => accountSignIn(accountCtx(i), i.account, i.scope));
  // 3: ANTHROPIC_API_KEY set counts as signed in.
  recordCase("signin-claude-env-key", {
    now: NOW, env: { ANTHROPIC_API_KEY: "sk-x" }, files: {},
    account: { name: "claude", kind: "claude", source: "native" }, scope: claudeScope,
  }, (i: any) => accountSignIn(accountCtx(i), i.account, i.scope));
  // 4: a codex account with auth.json present is signed in.
  recordCase("signin-codex-auth-file", {
    now: NOW, env: {}, files: { "~/.codex/auth.json": { content: "{}", mtime: NOW - 60 } },
    account: { name: "codex", kind: "codex", source: "native" }, scope: codexScope,
  }, (i: any) => accountSignIn(accountCtx(i), i.account, i.scope));
  // 5: an authentication failure newer than the login file mtime signs it out.
  const failedAt = NOW - 100;
  recordCase("signin-codex-failed", {
    now: NOW, env: {}, files: {
      "~/.codex/auth.json": { content: "{}", mtime: failedAt - 600 },
      "state/auth-failed.json": { content: JSON.stringify({ codex: failedAt }) },
      "state/auth-evidence.json": { content: JSON.stringify({ codex: { at: failedAt, scope: codexScope } }) },
    },
    account: { name: "codex", kind: "codex", source: "native" }, scope: codexScope,
  }, (i: any) => accountSignIn(accountCtx(i), i.account, i.scope));
  // 6: a failure older than the login file mtime is recovered.
  recordCase("signin-codex-recovered", {
    now: failedAt + 61, env: {}, files: {
      "~/.codex/auth.json": { content: "{}", mtime: failedAt + 60 },
      "state/auth-failed.json": { content: JSON.stringify({ codex: failedAt }) },
      "state/auth-evidence.json": { content: JSON.stringify({ codex: { at: failedAt, scope: codexScope } }) },
    },
    account: { name: "codex", kind: "codex", source: "native" }, scope: codexScope,
  }, (i: any) => accountSignIn(accountCtx(i), i.account, i.scope));
  // 7: an Orca account whose folder is missing reports null.
  const orcaId = "abc";
  const orcaScope = accountEvidenceScope({ name: "o", kind: "claude", source: "orca", orcaAccount: orcaId } as any);
  recordCase("signin-orca-missing", {
    now: NOW, env: { ORCA_USER_DATA_PATH: "/nonexistent-orca-root" }, files: {},
    account: { name: "o", kind: "claude", source: "orca", orcaAccount: orcaId }, scope: orcaScope,
  }, (i: any) => accountSignIn(accountCtx(i), i.account, i.scope));
  // 8: an endpoint account has no local sign-in.
  recordCase("signin-endpoint", {
    now: NOW, env: {}, files: {},
    account: { name: "api", kind: "endpoint", source: "native" }, scope: { account: "api", identity: ID },
  }, (i: any) => accountSignIn(accountCtx(i), i.account, i.scope));
  await record("signin");
});

test("remote-usage goldens match the TypeScript cache read rule", () => {
  cases = [];
  const account = { name: "codex", kind: "codex", source: "native" } as any;
  const identity = accountEvidenceScope(account).identity;
  const reading = { windows: [{ name: "5h", usedPct: 20, resetsAt: NOW + 3600, lengthS: 18000, paced: false }], capturedAt: NOW - 10, stale: false, source: "session-log", remoteHost: "box" };
  const hosts = { box: { alias: "box", ssh: "box-ssh", accounts: { codex: { home: "~/.codex" } } } };
  // 1: version 3 with a matching identity and source returns the reading.
  recordCase("remote-usage-match", {
    now: NOW, account, hosts,
    files: { "cache/remote-usage/codex.json": { content: JSON.stringify({ version: 3, identity, sourceIdentity: JSON.stringify(["box", "box-ssh", "~/.codex"]), reading }) } },
  }, (i: any) => cachedRemoteUsage(accountCtx(i), i.account, i.hosts));
  // 2: an older version becomes a staleness marker with no alternatives.
  recordCase("remote-usage-version2", {
    now: NOW, account, hosts,
    files: { "cache/remote-usage/codex.json": { content: JSON.stringify({ version: 2, identity, sourceIdentity: JSON.stringify(["box", "box-ssh", "~/.codex"]), reading }) } },
  }, (i: any) => cachedRemoteUsage(accountCtx(i), i.account, i.hosts));
  // 3: a remoteHost absent from hosts also yields the stale copy.
  recordCase("remote-usage-missing-host", {
    now: NOW, account, hosts: {},
    files: { "cache/remote-usage/codex.json": { content: JSON.stringify({ version: 3, identity, sourceIdentity: JSON.stringify(["box", "box-ssh", "~/.codex"]), reading }) } },
  }, (i: any) => cachedRemoteUsage(accountCtx(i), i.account, i.hosts));
  // 4: a damaged file maps to null.
  recordCase("remote-usage-damaged", {
    now: NOW, account, hosts,
    files: { "cache/remote-usage/codex.json": { content: "{not json" } },
  }, (i: any) => cachedRemoteUsage(accountCtx(i), i.account, i.hosts));
  record("remote-usage");
});

test("endpoint goldens match the TypeScript endpoint row rule", () => {
  cases = [];
  // 1: an opencode source exposes its provider alongside the saved state.
  recordCase("endpoint-opencode", {
    now: NOW, files: { "endpoints/state.json": { content: JSON.stringify({ oc: { state: "ready", checked_at: "2026-10-10T19:00:00Z" } }) } },
    account: { name: "oc", kind: "endpoint", source: "opencode", provider: "anthropic" },
  }, async (i: any) => endpointRow(accountCtx(i), i.account));
  // 2: an endpoint with no connection reports external only when it is an endpoint.
  recordCase("endpoint-external", {
    now: NOW, files: {}, account: { name: "api", kind: "endpoint", source: "native" },
  }, async (i: any) => endpointRow(accountCtx(i), i.account));
  // 3: a connection with a file key present keeps the saved state and says present.
  recordCase("endpoint-key-present", {
    now: NOW, files: {
      "secrets/demo.key": { content: "sk-demo" },
      "endpoints/state.json": { content: JSON.stringify({ demo: { state: "ready" } }) },
    },
    account: { name: "demo", kind: "endpoint", source: "native", connection: { api: "openai-compatible", base_url: "http://127.0.0.1:9/v1", key: "file", models: [{ id: "m" }] } },
  }, async (i: any) => endpointRow(accountCtx(i), i.account));
  // 4: a connection without its key becomes key_missing with key missing.
  recordCase("endpoint-key-missing", {
    now: NOW, files: {
      "endpoints/state.json": { content: JSON.stringify({ demo: { state: "not_tested" } }) },
    },
    account: { name: "demo", kind: "endpoint", source: "native", connection: { api: "openai-compatible", base_url: "http://127.0.0.1:9/v1", key: "file", models: [{ id: "m" }] } },
  }, async (i: any) => endpointRow(accountCtx(i), i.account));
  // 5: a base_url with a port keeps the port in the host.
  recordCase("endpoint-base-url-port", {
    now: NOW, files: { "secrets/demo.key": { content: "sk-demo" } },
    account: { name: "demo", kind: "endpoint", source: "native", connection: { api: "openai-compatible", base_url: "http://host.example:8443/v1", key: "file", models: [] } },
  }, async (i: any) => endpointRow(accountCtx(i), i.account));
  record("endpoint");
});

// ---- B12-3 activity goldens ---------------------------------------------------
// buildActivity and loadActivity read grow-only Claude/Codex logs and cache a
// 168-bin weekly profile plus per-file cursors. The fixture records an ordered
// `ops` script the Rust pacer-status tests replay identically (crates/status/
// tests/activity.rs): it writes logs (with pinned mtimes so cursor `mtime` is
// deterministic), appends, removes, and runs builds/loads. Cursor inodes are
// machine-specific, so expected cursors are normalized (inode -> 0).

type ActivityOp =
  | { write: { path: string; content: string; mtime?: number } }
  | { append: { path: string; content: string; mtime?: number } }
  | { remove: { path: string } }
  | { build: { now: number; lookbackDays?: number; threshold?: number } }
  | { load: { now: number; readOnly?: boolean; lockToken?: string } };

function actPath(ctx: Ctx, rel: string): string {
  return rel.startsWith("~/") ? join(ctx.home, rel.slice(2)) : join(ctx.pacerHome, rel);
}
function actOut(ctx: Ctx): { profile: unknown; cursors: unknown; activityJson: string | null; lock: boolean } {
  const cursorPath = join(ctx.pacerHome, "state", "activity-cursors.json");
  const raw = existsSync(cursorPath) ? readJson(cursorPath) : null;
  const cursors = raw ? normalizeCursors(raw, ctx.home) : null;
  const activityPath = join(ctx.pacerHome, "activity.json");
  const activityJson = existsSync(activityPath) ? readFileSync(activityPath, "utf8") : null;
  return { profile: null, cursors, activityJson, lock: existsSync(join(ctx.pacerHome, "activity.lock")) };
}
// Cursor inodes and the absolute log paths in `files` are machine-specific:
// zero each inode and make every cursor key home-relative (`~/` prefix), so
// the Rust replay (a different tempdir) sees identical expected cursors.
function normalizeCursors(v: any, home: string): any {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      let key = k;
      if (k === "inode") { out[key] = 0; continue; }
      if (k.startsWith(home + "/")) key = "~/" + k.slice(home.length + 1);
      out[key] = normalizeCursors(val, home);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => normalizeCursors(x, home));
  return v;
}
async function runActivityOps(ctx: Ctx, ops: ActivityOp[]): Promise<unknown> {
  let profile: unknown = null;
  for (const op of ops) {
    if ("write" in op) {
      const p = actPath(ctx, op.write.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, op.write.content);
      if (op.write.mtime !== undefined) utimesSync(p, op.write.mtime, op.write.mtime);
    } else if ("append" in op) {
      const p = actPath(ctx, op.append.path);
      appendFileSync(p, op.append.content);
      if (op.append.mtime !== undefined) utimesSync(p, op.append.mtime, op.append.mtime);
    } else if ("remove" in op) {
      unlinkSync(actPath(ctx, op.remove.path));
    } else if ("build" in op) {
      profile = await buildActivity({ ...ctx, now: op.build.now }, { lookbackDays: op.build.lookbackDays, threshold: op.build.threshold });
    } else if ("load" in op) {
      const c = {
        ...ctx, now: op.load.now,
        ...(op.load.readOnly ? { readOnly: true as const } : {}),
        env: { ...ctx.env, ...(op.load.lockToken ? { PACER_ACTIVITY_LOCK_TOKEN: op.load.lockToken } : {}) },
      };
      profile = await loadActivity(c, { trigger: () => {} });
    }
  }
  const out = actOut(ctx);
  out.profile = profile;
  return out;
}
// A ~70-minute spread of log stamps across 3 days and 5 distinct hours, so a
// 0.2 threshold marks a subset active and 28-day / same-hour lookbacks differ.
function genLogs(prefix: string, tsOffsets: number[]): string {
  return tsOffsets.map((ts) => JSON.stringify({ type: "user", timestamp: new Date(ts * 1000).toISOString() })).join("\n");
}
// Seconds since epoch for a local wall clock (tests run with TZ=Asia/Ho_Chi_Minh).
const H = 3600;
// Race must be cleared: buildActivity keeps a process-global cursor store keyed
// by path, so every case gets its own fake home (fresh store).

test("activity goldens match the TypeScript activity profile and cursor writes", async () => {
  cases = [];
  const T = localTs(2026, 10, 10, 19, 0); // Saturday 19:00 local
  const early = localTs(2026, 10, 8, 9, 5); // Thu 09:05
  const stamps: number[] = [];
  for (const h of [9, 10, 11]) for (const m of [5, 40]) stamps.push(localTs(2026, 10, 8, h, m));
  // 1: a fresh home full-scans its logs into a profile and persists cursors.
  recordActivity("build-initial", {
    now: T, env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "~/.claude/projects/-p/one.jsonl": { content: genLogs("c", stamps), mtime: T - 60 },
      "~/.codex/sessions/box/rollout-two.jsonl": { content: genLogs("x", [early + 60]), mtime: T - 60 },
    },
    ops: [{ build: { now: T } }],
  });
  // 2: a second build reuses the persisted cursors (same size+mtime) and the profile is unchanged.
  recordActivity("build-reuse", {
    now: T, env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "~/.claude/projects/-p/one.jsonl": { content: genLogs("c", stamps), mtime: T - 60 },
    },
    ops: [{ build: { now: T } }, { build: { now: T + 300 } }],
  });
  // 3: appending to a log grows the cursor offset and folds the new hour in.
  recordActivity("build-append", {
    now: T, env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "~/.claude/projects/-p/one.jsonl": { content: genLogs("c", stamps), mtime: T - 60 },
    },
    ops: [
      { build: { now: T } },
      { append: { path: "~/.claude/projects/-p/one.jsonl", content: "\n" + genLogs("c2", [localTs(2026, 10, 9, 13, 30)]), mtime: T + 10 } },
      { build: { now: T + 20 } },
    ],
  });
  // 4: a vanished log is pruned from the cursor map on the next build.
  recordActivity("build-vanished", {
    now: T, env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "~/.codex/sessions/box/rollout-keep.jsonl": { content: genLogs("k", [early]), mtime: T - 60 },
      "~/.codex/sessions/box/rollout-gone.jsonl": { content: genLogs("g", [early + 3600]), mtime: T - 60 },
    },
    ops: [
      { build: { now: T } },
      { remove: { path: "~/.codex/sessions/box/rollout-gone.jsonl" } },
      { build: { now: T + 30 } },
    ],
  });
  // 5: a short lookback lands in the same clock hour -> exact-window scan, no reuse.
  recordActivity("build-same-hour", {
    now: localTs(2026, 10, 10, 10, 50), env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "~/.claude/projects/-p/now.jsonl": { content: genLogs("s", [localTs(2026, 10, 10, 10, 20)]), mtime: localTs(2026, 10, 10, 10, 40) },
    },
    ops: [{ build: { now: localTs(2026, 10, 10, 10, 50), lookbackDays: 0.03 } }],
  });
  // 6: a fresh cache younger than 1h is returned without touching cursors or lock.
  recordActivity("load-cache-fresh", {
    now: T, env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "activity.json": { content: JSON.stringify({ builtAt: T - 3600, days: 0, bins: new Array(168).fill(0), active: new Array(168).fill(false) }) },
    },
    ops: [{ load: { now: T } }],
  });
  // 7: a 25h-old cache is returned and triggers a rebuild; the bogus lock
  // token keeps the lock in place so the lock-present state is deterministic.
  recordActivity("load-cache-stale-25h", {
    now: T, env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "activity.json": { content: JSON.stringify({ builtAt: T - 25 * H, days: 0, bins: new Array(168).fill(0), active: new Array(168).fill(false) }) },
    },
    ops: [{ load: { now: T, lockToken: "bogus" } }],
  });
  // 8: readOnly staleness returns the cache without taking the lock.
  recordActivity("load-readonly", {
    now: T, env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "activity.json": { content: JSON.stringify({ builtAt: T - 25 * H, days: 0, bins: new Array(168).fill(0), active: new Array(168).fill(false) }) },
    },
    ops: [{ load: { now: T, readOnly: true } }],
  });
  // 9: no cache -> build fresh, write activity.json and cursors.
  recordActivity("load-no-cache", {
    now: T, env: { TZ: "Asia/Ho_Chi_Minh" },
    files: {
      "~/.claude/projects/-p/two.jsonl": { content: genLogs("n", [early]), mtime: T - 60 },
    },
    ops: [{ load: { now: T } }],
  });
  await record("activity");
});

function recordActivity(name: string, input: { now: number; env: Record<string, string>; files: Record<string, FileSpec>; ops: ActivityOp[] }): void {
  cases.push({
    name: `activity:${name}`,
    input: { now: input.now, env: input.env, files: input.files, ops: input.ops },
    expected: (async () => {
      const ctx = accountCtx({ now: input.now, env: input.env, files: input.files });
      return await runActivityOps(ctx, input.ops);
    })(),
  });
}

function recordCase(name: string, input: unknown, run: (i: any) => unknown): void {
  cases.push({ name, input, expected: run(input) });
}
function fact(source: UsageSource | "execution" | "configuration", observedAt: number, reason: string, value: unknown, budgetPolicy?: string) {
  return evidenceFact<unknown>(SCOPE, source, observedAt, null, reason, value, budgetPolicy);
}
function factCase(key: string, o: { source: UsageSource | "execution" | "configuration"; observedAt: number | null; validUntil: number | null; reason: string; value: unknown; budgetPolicy?: string }): void {
  const input: Record<string, unknown> = { scope: SCOPE, source: o.source, observedAt: o.observedAt, validUntil: o.validUntil, reason: o.reason, value: o.value };
  if (o.budgetPolicy !== undefined) input.budgetPolicy = o.budgetPolicy;
  cases.push({ name: `fact:${key}`, input, expected: evidenceFact(SCOPE, o.source, o.observedAt, o.validUntil, o.reason, o.value, o.budgetPolicy as any) });
}
function readingCase(name: string, usage: UsageKind, r: UsageReading): void {
  cases.push({ name: `reading:${name}`, input: { scope: SCOPE, reading: r, usage }, expected: readingEvidence(SCOPE, r, usage) });
}
function reconcileCase(name: string, previous: AccountEvidence, incoming: AccountEvidence, now: number): void {
  cases.push({ name: `reconcile:${name}`, input: { previous, incoming, now }, expected: reconcileEvidence(previous, incoming, now) });
}