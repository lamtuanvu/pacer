import type {Strategy} from "../config/strategy";
import {readProjectStrategies} from "../config/project-strategies";
import {executorExclusion} from "../executors/availability";
import {CoreError} from "../core/errors";
import {getWork} from "../dispatch/work";
import type {Ctx} from "../types";
import {readTask} from "./store";
import type {TaskRecord} from "./types";

interface RouteAdmissionOptions {
  strategy: (ctx:Ctx) => Strategy;
  contextFingerprint: () => string;
  signal?: AbortSignal;
  deadline?: number;
}
/** Policy never runs under slot/task locks. Revalidate under selection/launch locks. */
export async function authorizeRoute(ctx:Ctx,id:string,candidates:readonly string[],options:RouteAdmissionOptions) {
  const initial=readTask(ctx,id);
  if(!initial) throw new CoreError("unknown_task",`unknown task ${id}`);
  let expectedRev=initial.rev;
  const current=()=>{
    const task=readTask(ctx,id);
    if(!task || task.rev!==expectedRev || !["queued","running"].includes(task.state)) throw new CoreError("conflict","Task changed during route admission");
    return task;
  };
  const capture=()=>{
    const task=readTask(ctx,id),strategy=options.strategy(ctx);
    // Own selection bookkeeping advances revisions through checkpoint(), while
    // the immutable routing request and operation owner remain bound here.
    const request=task?{id:task.id,brief:task.brief,kind:task.kind,requestedExecutor:task.requestedExecutor,repo:task.repo,
      placement:task.placement,worktree:task.worktree,attempts:task.attempts.length,runnerPid:task.runnerPid,
      state:["queued","running"].includes(task.state)?"active":task.state}:null;
    return JSON.stringify({strategy,projects:readProjectStrategies(ctx),request,work:getWork(ctx,id),candidates,
      guards:candidates.map(candidate=>[candidate,executorExclusion({...ctx,now:Date.now()/1000},strategy,candidate)]),context:options.contextFingerprint()});
  };
  const {applyPolicy}=await import("../plugins/policy");
  current();
  let receipt:Awaited<ReturnType<typeof applyPolicy>>;
  try {receipt=await applyPolicy(ctx,"route",{taskId:id,candidates:[...candidates]},{contextFingerprint:capture,signal:options.signal,deadline:options.deadline});}
  catch(error){current();throw error;}
  current();
  if(receipt.params.decision!=="route") throw new CoreError("invalid_input","Invalid route policy receipt");
  return {
    candidates:[...receipt.params.input.candidates],excludedBy:{...receipt.excludedBy},
    revalidate:()=>{current();receipt.revalidate();},
    /** Accept only the immediately adjacent synchronous write made by this operation. */
    checkpoint(task:TaskRecord) {
      if(task.id!==id || task.rev!==expectedRev+1 || readTask(ctx,id)?.rev!==task.rev) throw new CoreError("conflict","Task changed during route selection");
      receipt.revalidate();
      expectedRev=task.rev;
    },
  };
}
