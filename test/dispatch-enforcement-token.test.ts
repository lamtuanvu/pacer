import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { authorizeEnforcementToken, issueEnforcementToken, revokeEnforcementTokens } from "../src/dispatch/enforcement-token";

function runningWithoutDelegation() {
  const ctx=fakeCtx(),task=createTask(ctx,{brief:{goal:"work",repo:tmpDir()},kind:"feature",requestedExecutor:null,timeoutS:600});
  registerWork(ctx,task.id,{allowDelegation:false});
  updateTask(ctx,task.id,t=>{t.state="running";});
  return {ctx,task};
}

test("strict attempts have an enforcement identity even without a child grant",()=>{
  const {ctx,task}=runningWithoutDelegation();
  const token=issueEnforcementToken(ctx,task.id,1);
  expect(token).toMatch(/^pet_[0-9a-f]{64}$/);
  expect(authorizeEnforcementToken(ctx,token)).toEqual({taskId:task.id,attempt:1});
  const db=dispatchDatabase(ctx);
  expect(JSON.stringify(db.query("SELECT * FROM enforcement_tokens").all())).not.toContain(token);
  expect(()=>authorizeEnforcementToken(ctx,"pet_"+"0".repeat(64))).toThrow();
});

test("enforcement identity expires, revokes, and never authorizes another attempt",()=>{
  const {ctx,task}=runningWithoutDelegation();
  const token=issueEnforcementToken(ctx,task.id,1);
  expect(()=>authorizeEnforcementToken({...ctx,now:ctx.now+601},token)).toThrow();
  revokeEnforcementTokens(ctx,task.id);
  expect(()=>authorizeEnforcementToken(ctx,token)).toThrow();
  const next=issueEnforcementToken(ctx,task.id,1);
  updateTask(ctx,task.id,t=>{t.state="stopped";});
  expect(()=>authorizeEnforcementToken(ctx,next)).toThrow();
});
