import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listTasks } from "../tasks/store";
import { TERMINAL_STATES, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
const ARTIFACTS=["session.activity","session.log","session.log.1","session.ckpt","session.ckpt.tmp","session.sock.path","session.host","session.json"];
/** Keep plain stdout/stderr/exit for byte-offset readers and legacy reports. */
export function pruneTaskSessions(ctx:Ctx,task:TaskRecord):void {
  if(!TERMINAL_STATES.includes(task.state)) return;
  const root=join(ctx.pacerHome,"runs",task.id);
  if(!existsSync(root)) return;
  for(const attempt of readdirSync(root,{withFileTypes:true})) if(attempt.isDirectory()) {
    for(const name of ARTIFACTS) rmSync(join(root,attempt.name,name),{force:true});
  }
}
/** Safe to call periodically or before a new local session. */
export function pruneSessions(ctx:Ctx,days=14):void {
  try {
    for(const task of listTasks(ctx,Number.MAX_SAFE_INTEGER)) {
      const settled=task.attempts.at(-1)?.endedAt ?? task.createdAt;
      if(TERMINAL_STATES.includes(task.state) && ctx.now-settled > days*86400) pruneTaskSessions(ctx,task);
    }
  } catch { /* retention must not prevent launches */ }
}

/** Clean-command hook for settled, reviewed/dismissed/resolved in-place tasks too. */
export function cleanSettledSessions(ctx:Ctx):void {
  for(const task of listTasks(ctx,Number.MAX_SAFE_INTEGER)) {
    if(task.review || task.dismissed || task.resolved) pruneTaskSessions(ctx,task);
  }
}
