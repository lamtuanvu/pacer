import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { checkAccountUsage, accountUsageCapability } from "../src/core/account-usage-check";
import { registerJobDaemon, getJob } from "../src/jobs/registry";
import { loadStrategy } from "../src/config/strategy";
import { fakeCtx } from "./helpers";

function setup() {
  const ctx = fakeCtx({now: 1_800_000_000});
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: {agent: "claude-code", account: "work"}, accounts: {work: {kind: "claude"}, codex: {kind: "codex"}, cursor: {kind: "cursor"}, local: {kind: "endpoint", usage: "unmetered"}}, runners: {}, routing: []}));
  return ctx;
}
const reading = {windows: [{name: "weekly", usedPct: 20, resetsAt: null, lengthS: 604800, paced: true}], capturedAt: 1_799_999_990, stale: false};
test("account capability distinguishes consent, reads, reactive and unmetered", () => {
  const accounts = loadStrategy(setup()).accounts;
  expect(Object.fromEntries(Object.entries(accounts).map(([name, a]) => [name, accountUsageCapability(a).action]))).toEqual({work: "probe", codex: "refresh", cursor: "unsupported", local: "unmetered"});
});
test("API refuses a Claude check without explicit consent before launching", async () => {
  const ctx = setup();
  await expect(callOp(ctx, "account.usage.check", {account: "work"})).rejects.toMatchObject({code: "not_allowed"});
});
test("planner account without executor collects new telemetry even when cached usage is current", async () => {
  const ctx = setup(); let launched = 0, reads = 0;
  const job = await checkAccountUsage(ctx, "work", true, {
    probe: async (_ctx, account) => { expect(account.name).toBe("work"); launched++; },
    read: async (_ctx, _account, runners, refresh) => { expect(runners.every(r => r.account === "work")).toBe(true); if (refresh) reads++; return {...reading, capturedAt: reads ? ctx.now : reading.capturedAt}; },
  });
  expect(launched).toBe(1); expect(reads).toBe(1);
  expect(job).toMatchObject({kind: "account.usage.check", target: "work", state: "passed"});
  expect(job.steps.at(-1)?.detail).toContain("New usage observation");
});
test("unchanged Claude telemetry fails honestly and preserves original observation", async () => {
  const ctx = setup();
  const job = await checkAccountUsage(ctx, "work", true, {probe: async () => {}, read: async () => reading});
  expect(job.state).toBe("failed"); expect(job.error?.message).toContain("No new usage observation");
});
test("duplicate account checks coalesce into one quota-consuming probe", async () => {
  const ctx = setup(), stop = registerJobDaemon(ctx); let release!: () => void, launched = 0;
  const wait = new Promise<void>(resolve => {release = resolve;});
  const deps = {probe: async () => {launched++; await wait;}, read: async () => reading};
  try {
    const [a,b] = await Promise.all([checkAccountUsage(ctx, "work", true, deps), checkAccountUsage(ctx, "work", true, deps)]);
    expect(a.id).toBe(b.id); expect(launched).toBe(1);
    release();
    for (let n=0; n<100 && getJob(ctx,a.id).state === "running"; n++) await Bun.sleep(10);
    expect(getJob(ctx,a.id).state).toBe("failed");
  } finally {release(); stop();}
});
test("unchanged refresh is skipped, errors fail and unsupported accounts never probe", async () => {
  const ctx = setup();
  const deps = {probe: async () => {throw Error("must not probe");}, refresh: async () => ({account: "codex", capability: "provider-command" as const, outcome: "unchanged" as const, capturedAt: reading.capturedAt, source: null, error: null})};
  const job = await checkAccountUsage(ctx,"codex",false,deps);
  expect(job.steps.at(-1)).toMatchObject({state: "skipped", detail: expect.stringContaining("No new usage observation")});
  await expect(checkAccountUsage(ctx,"cursor",false,deps)).rejects.toMatchObject({code:"not_allowed"});
  await expect(checkAccountUsage(ctx,"local",false,deps)).rejects.toMatchObject({code:"not_allowed"});
  const failed = await checkAccountUsage(ctx,"codex",false,{...deps,refresh:async()=>({...await deps.refresh(),outcome:"failed",error:"Sign in to Ark CLI"})});
  expect(failed).toMatchObject({state:"failed",error:{message:"Sign in to Ark CLI"}});
});
test("v3 API returns an account job and refreshes the read model after completion", async () => {
  const ctx=setup(); let completed=0;
  const job=await callOp(ctx,"account.usage.check",{account:"work",consent:true},{accountUsageCheck:{probe:async()=>{},read:async(_ctx,_account,_runners,refresh)=>({...reading,capturedAt:refresh?ctx.now:reading.capturedAt})},usageRefreshDone:async()=>{completed++;}});
  expect(job).toMatchObject({kind:"account.usage.check",target:"work",state:"passed"});
  expect(completed).toBe(1);
  await expect(callOp(ctx,"account.usage.check",{account:"missing"})).rejects.toMatchObject({code:"invalid_input"});
});
test("failed checks redact environment secrets before persisting a job", async () => {
  const ctx=setup();ctx.env.PROVIDER_TOKEN="private-token-value";
  const job=await checkAccountUsage(ctx,"work",true,{read:async()=>reading,probe:async()=>{throw Error("provider rejected private-token-value");}});
  expect(job.state).toBe("failed");expect(JSON.stringify(job)).not.toContain("private-token-value");
});

test("delegated callers cannot request a quota-consuming account check", async () => {
  const {assertCallerCanInvoke} = await import("../src/api/caller-policy");
  const ctx = setup(); ctx.env.PACER_ROLE = "executor";
  expect(() => assertCallerCanInvoke(ctx, "account.usage.check", {account: "work", consent: true})).toThrow("cannot delegate onward");
});
