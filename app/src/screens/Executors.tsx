import { useState } from "preact/hooks";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { Pill } from "../ds/Pill";
import { executorStatus, runnerAccount, reorderRules, type Rule, type RoutingRules } from "../model/executors";
import type { Account } from "../model/accounts";
import type { Runner } from "../model/home";
import { executorName } from "../model/tasks";
import { Dialog, ErrorMessage, useAction, useQuery } from "./task-shared";
export function Executors() {
  const routing = useQuery<RoutingRules>("routing.get", {}), runners = useQuery<Runner[]>("runner.list", {}), accounts = useQuery<Account[]>("account.list", {});
  const [draft, setDraft] = useState<Rule[]>();
  const action = useAction();
  const [remove, setRemove] = useState<string>();
  const reload = () => { routing.reload(); runners.reload(); accounts.reload(); };
  const rules = draft ?? routing.data?.rules ?? [];
  return <section className="screen"><div className="top"><h1>Executors</h1><span className="grow" /><a className="pc-btn pc-btn--primary pc-btn--md" href="#/executors/add">+ Add executor</a></div>
    <p className="muted">Work goes to the first available executor in each routing rule. Move executors up or down, then save the order.</p>
    <ErrorMessage error={routing.error ?? runners.error ?? accounts.error} />
    {rules.map((rule, ruleIndex) => <Card key={ruleIndex}><h2>{rule.kinds?.join(", ") ?? "Default order"}</h2>{rule.executors.map((id, index) => <ExecutorRow key={id} id={id} runner={runners.data?.find(r => r.id === id)} account={runnerAccount(id, accounts.data ?? [])} index={index} count={rule.executors.length} move={direction => setDraft(reorderRules(rules, ruleIndex, index, direction))} remove={() => setRemove(id)} reload={reload} />)}{!rule.executors.length && <p>No executors yet. <a href="#/executors/add">Add one</a>.</p>}</Card>)}
    {!!routing.data?.available.filter(id => !rules.some(r => r.executors.includes(id))).length && <Card><h2>Outside routing</h2>{routing.data.available.filter(id => !rules.some(r => r.executors.includes(id))).map(id => <ExecutorRow key={id} id={id} runner={runners.data?.find(r => r.id === id)} account={runnerAccount(id, accounts.data ?? [])} remove={() => setRemove(id)} reload={reload} />)}</Card>}
    {draft && <Button disabled={action.busy} onClick={() => { void action.run("routing.set", { rules: draft }, () => { setDraft(undefined); reload(); }); }}>Save order</Button>}
    <div aria-live="polite"><ErrorMessage error={action.error} />{action.message}</div>
    {remove && <Dialog title="Remove executor?" close={() => setRemove(undefined)}><p>Remove {executorName(remove)} ({remove}) from executors and routing?</p><ErrorMessage error={action.error} /><Button disabled={action.busy} onClick={() => { void action.run("runner.remove", { id: remove }, () => { setRemove(undefined); setDraft(undefined); reload(); }); }}>Remove executor</Button></Dialog>}
  </section>;
}
function ExecutorRow({ id, runner, account, index, count, move, remove, reload }: { id: string; runner?: Runner; account?: Account; index?: number; count?: number; move?: (d: -1 | 1) => void; remove: () => void; reload: () => void }) {
  const action = useAction(), [duration, setDuration] = useState("1h");
  const status = executorStatus(runner ?? { id, state: "ok", until: null, reason: null }, account);
  return <div className="task-row"><span>{index === undefined ? "" : index + 1}</span><div className="grow"><strong>{executorName(id)}</strong><div className="muted">{id}{account && ` · Account ${account.name}`}</div>{status.detail && <p>{status.detail}</p>}</div><Pill tone={status.tone}>{status.label}</Pill><div className="row-actions">
    {move && <><Button size="sm" aria-label={`Move ${id} up`} disabled={index === 0} onClick={() => move(-1)}>Up</Button><Button size="sm" aria-label={`Move ${id} down`} disabled={index === count! - 1} onClick={() => move(1)}>Down</Button></>}
    {runner?.state === "blocked" ? <Button disabled={action.busy} onClick={() => { void action.run("runner.unblock", { id }, reload); }}>Unblock</Button> : <><label>Block for <select aria-label={`Block duration for ${id}`} value={duration} onChange={e => setDuration(e.currentTarget.value)}><option value="30m">30 minutes</option><option value="1h">1 hour</option><option value="1d">1 day</option><option value="">Until unblocked</option></select></label><Button disabled={action.busy} onClick={() => { void action.run("runner.block", { id, ...(duration ? { for: duration } : {}) }, reload); }}>Block</Button></>}
    {account?.kind === "endpoint" && <Button disabled={action.busy} onClick={() => { void action.run<{ state: string; detail?: string }>("account.test", { name: account.name }, result => { reload(); if (!["ready", "Ready"].includes(result.state)) throw new Error(result.detail ?? result.state); }); }}>{action.busy ? "Testing…" : "Run a test task"}</Button>}
    <Button onClick={remove}>Remove</Button></div><div className="row-result" aria-live="polite"><ErrorMessage error={action.error} />{action.message}</div></div>;
}
