import { expect, test } from "bun:test";
import { executorExclusion } from "../src/executors/availability";
import { blockExecutor } from "../src/executors/blocked";
import { validateStrategy } from "../src/config/strategy";
import { accountEvidenceScope, mergeEvidence, retireEvidence } from "../src/core/evidence";
import { emptyEvidence, evidenceFact } from "../src/engine/evidence";
import { markExhausted, readMarks } from "../src/usage/reactive";
import { fakeCtx } from "./helpers";

const strategy = (paid = false) => validateStrategy({planner:"claude-code",providers:{"claude-code":{},codex:{allow_paid:paid}}},"test");

test("late guard preserves recovery despite a retained execution limit sidecar", async () => {
  const ctx=fakeCtx(),s=strategy(),scope=accountEvidenceScope(s.accounts.codex,s.hosts);
  markExhausted({...ctx,now:ctx.now-30},"codex",ctx.now+3600,{scope});
  const facts=emptyEvidence();
  facts.budget.push(evidenceFact(scope,"session-log",ctx.now-10,null,"quota_observed",{name:"5h",usedPct:20,resetsAt:ctx.now+3600,lengthS:18000,paced:false}));
  await mergeEvidence(ctx,scope,facts);
  expect(readMarks(ctx).codex).toBeGreaterThan(ctx.now);
  expect(executorExclusion(ctx,s,"codex")).toBeUndefined();
});

test("late guard honors paid permission but never a user block", () => {
  const ctx=fakeCtx();
  markExhausted(ctx,"codex",ctx.now+3600,{manual:true});
  expect(executorExclusion(ctx,strategy(),"codex")).toBe("exhausted");
  expect(executorExclusion(ctx,strategy(true),"codex")).toBeUndefined();
  blockExecutor(ctx,"codex#codex");
  expect(executorExclusion(ctx,strategy(true),"codex")).toBe("Blocked by you");
});

test("late guard does not promote unscoped, stale or wrong-scope marks into exclusions", () => {
  const ctx=fakeCtx(),s=strategy(),scope=accountEvidenceScope(s.accounts.codex,s.hosts);
  markExhausted(ctx,"codex",ctx.now+3600);
  expect(executorExclusion(ctx,s,"codex")).toBeUndefined();
  for(const other of [{...scope,identity:"a".repeat(64)},{...scope,model:"another"},{...scope,host:"remote"},{...scope,runner:"another"}]) {
    markExhausted(ctx,"codex",ctx.now+3600,{scope:other});
    expect(executorExclusion(ctx,s,"codex")).toBeUndefined();
  }
  markExhausted({...ctx,now:ctx.now-90000},"codex",ctx.now+3600,{scope});
  expect(executorExclusion(ctx,s,"codex")).toBeUndefined();
});

test("late guard ignores an execution marker from a retired account lifetime", () => {
  const ctx=fakeCtx(),s=strategy(),scope=accountEvidenceScope(s.accounts.codex,s.hosts);
  markExhausted({...ctx,now:ctx.now-10},"codex",ctx.now+3600,{scope});
  retireEvidence(ctx,scope);
  expect(executorExclusion({...ctx,now:ctx.now+1},s,"codex")).toBeUndefined();
});
