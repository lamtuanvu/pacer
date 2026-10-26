import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { authorizeEnforcementToken, issueEnforcementToken, revokeEnforcementTokens } from "../src/dispatch/enforcement-token";
import { execProcess } from "../src/exec/process";

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
test("a work grant does not prevent the strict native guard command from running",async()=>{
  const ctx=fakeCtx();
  const result=await execProcess({argv:[process.execPath,"src/cli.ts","guard","--planner","claude-code"],cwd:process.cwd(),stdin:"{}",env:{...process.env,PACER_HOME:ctx.pacerHome,PACER_ROLE:"executor",PACER_WORK_GRANT:"pwg_"+"0".repeat(64),PACER_ENFORCEMENT_MODE:"strict",PACER_ENFORCEMENT_TOKEN:"pet_"+"0".repeat(64)},timeoutMs:10000});
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("native subagents are blocked");
  expect(result.stderr).not.toContain("work grants only allow");
});
