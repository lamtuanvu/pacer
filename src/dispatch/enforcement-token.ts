import { createHash, randomBytes } from "node:crypto";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import { dispatchDatabase } from "./store";
import { getWork } from "./work";

const hash=(token:string)=>createHash("sha256").update(token).digest("hex");

export function issueEnforcementToken(ctx:Ctx,id:string,attempt:number):string {
  const work=getWork(ctx,id),task=readTask(ctx,id);
  if(work?.options.delegationEnforcement!=="strict"||task?.state!=="running"||attempt!==task.attempts.length+1)
    throw new CoreError("not_allowed","Task cannot receive a strict enforcement identity");
  const token=`pet_${randomBytes(32).toString("hex")}`;
  const db=dispatchDatabase(ctx);
  db.transaction(()=>{
    db.query("UPDATE enforcement_tokens SET revoked=1 WHERE task_id=? AND attempt=?").run(id,attempt);
    db.query("INSERT INTO enforcement_tokens(hash,task_id,attempt,expires) VALUES(?,?,?,?)")
      .run(hash(token),id,attempt,Math.min(ctx.now+task.timeoutS,work.options.expiresAt??Infinity));
  }).immediate();
  return token;
}

export function authorizeEnforcementToken(ctx:Ctx,token:string):{taskId:string;attempt:number} {
  if(!/^pet_[0-9a-f]{64}$/.test(token))throw new CoreError("not_allowed","Invalid enforcement identity");
  const row=dispatchDatabase(ctx).query<{task_id:string;attempt:number;expires:number;revoked:number},[string]>(
    "SELECT task_id,attempt,expires,revoked FROM enforcement_tokens WHERE hash=?").get(hash(token));
  const task=row?readTask(ctx,row.task_id):null;
  if(!row||row.revoked||row.expires<=ctx.now||task?.state!=="running"||row.attempt!==task.attempts.length+1
    ||getWork(ctx,row.task_id)?.options.delegationEnforcement!=="strict")
    throw new CoreError("not_allowed","Expired or revoked enforcement identity");
  return {taskId:row.task_id,attempt:row.attempt};
}

export function revokeEnforcementTokens(ctx:Ctx,id:string):void {
  dispatchDatabase(ctx).query("UPDATE enforcement_tokens SET revoked=1 WHERE task_id=?").run(id);
}
