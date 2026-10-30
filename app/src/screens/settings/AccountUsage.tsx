import { useEffect, useRef } from "preact/hooks";
import type { Job } from "../../../../src/api/read-model/types";
import type { Account } from "../../model/accounts";
import { Button } from "../../ds/Button";
import { Disclosure } from "../../ds/Controls";
import { Stack } from "../../ds/Page";
import { useDialogs } from "../../ds/useDialogs";
import { useTaskContext } from "../task-shared";
import { latestJob, useOperation, useResource } from "./shared";

/** Each account owns its progress, including jobs started by another client. */
export function AccountUsage({account,reload,sourceError}:{account:Account;reload:()=>void;sourceError?:string}) {
  const {state}=useTaskContext(), dialogs=useDialogs();
  const action=useOperation(reload,{notifySuccess:false,notifyJob:false});
  const jobs=useResource<Job[]>("job.list",{target:account.name});
  const seen=new Map((jobs.data??[]).filter(j=>j.kind==="account.usage.check").map(j=>[j.id,j]));
  for(const event of Object.values(state.jobs)) if(event.target===account.name&&event.kind==="account.usage.check")seen.set(event.id,latestJob(event,seen.get(event.id))!);
  if(action.job)seen.set(action.job.id,latestJob(seen.get(action.job.id),action.job)!);
  const ordered=[...seen.values()].sort((a,b)=>b.startedAt-a.startedAt);
  const job=ordered.find(j=>j.state==="running")??ordered[0];
  const running=job?.state==="running", completed=useRef<string>(), pending=useRef(false);
  useEffect(()=>{if(!running)return;const timer=setInterval(jobs.reload,1500);return()=>clearInterval(timer);},[running]);
  useEffect(()=>{if(job&&job.state!=="running"&&completed.current!==job.id){completed.current=job.id;reload();}},[job?.id,job?.state]);
  // Provider guidance and diagnostics stay opt-in and appear only once.
  const details=[...new Set([
    action.error instanceof Error ? action.error.message : action.error ? String(action.error) : undefined,
    job?.error?.message, job?.error?.hint,
    ...(job?.steps.map(step=>step.detail)??[]), sourceError,
    jobs.error instanceof Error ? jobs.error.message : jobs.error ? String(jobs.error) : undefined,
  ].filter((detail):detail is string=>!!detail))];
  const status=action.error ? "Couldn’t check usage. Try again."
    : running||action.busy ? "Checking usage…"
    : job?.state==="failed" ? "Couldn’t check usage. Try again."
    : job?.state==="cancelled" ? "Usage check cancelled."
    : job?.state==="passed" ? job.steps.some(step=>step.state==="skipped") ? "Reading unchanged." : "Usage check complete."
    : jobs.error ? "Check progress unavailable. Reconnect to try again." : undefined;
  const disclosure=details.length>0&&<Disclosure key={job?.id??"source"} summary={<>Usage check details<span className="sr-only"> for {account.name}</span></>}>
    <Stack space="compact">{details.map(detail=><div key={detail}><code>{detail}</code></div>)}</Stack>
  </Disclosure>;
  const capability=account.usageCheck;
  if(!capability)return <Stack space="compact"><span className="u3-muted">Reconnect to load account usage controls.</span>{disclosure}</Stack>;
  const check=async()=>{
    if(pending.current||running)return;
    pending.current=true;
    try {
      if(capability.consentRequired&&!await dialogs.confirm(`Run a small Claude Code task for ${account.name}? This consumes this account’s subscription quota or paid usage. It collects a new usage observation and does not require an executor.`,"Check account usage","Run usage check"))return;
      await action.run("account.usage.check",{account:account.name,consent:capability.consentRequired});
    } finally {pending.current=false;}
  };
  return <Stack space="compact">
    {dialogs.dialog}
    {capability.action==="unsupported"||capability.action==="unmetered"?<span className="u3-muted">{capability.description}</span>:<>
      <Button size="sm" variant="quiet" busy={action.busy||running} disabled={action.busy||running||!state.connected} onClick={()=>void check()}>Check usage<span className="sr-only"> for {account.name}</span></Button>
      {!state.connected&&<span className="u3-muted">Reconnecting. Check usage when the service reconnects.</span>}
      <span role="status" aria-live="polite" aria-atomic="true" className="u3-muted">{status}</span>
    </>}
    {disclosure}
  </Stack>;
}
