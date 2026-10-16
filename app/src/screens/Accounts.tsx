import { useEffect, useState } from "preact/hooks";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { Pill } from "../ds/Pill";
import { UsageMeter } from "../ds/UsageMeter";
import { executorLabel } from "../model/tasks";
import { executorStatus } from "../model/executors";
import { accountsModel, clock, type Account, type Limit } from "../model/accounts";
import { Dialog, ErrorMessage, useAction, useDraft, useQuery } from "./task-shared";
export function Signin({ command }: { command: string }) {
  const [error, setError] = useState<unknown>(), [copied, setCopied] = useState(false);
  return <div><pre className="report">{command}</pre><Button onClick={() => { void navigator.clipboard.writeText(command).then(() => { setCopied(true); setError(undefined); }, setError); }}>{copied ? "Copied" : "Copy command"}</Button><ErrorMessage error={error} /></div>;
}
export function Accounts() {
  const accounts = useQuery<Account[]>("account.list", {}), limits = useQuery<Limit[]>("limits.check", {});
  const [adding, setAdding] = useState(false), [remove, setRemove] = useState<string>();
  const [draft, setDraft, clearDraft] = useDraft("pacer.add-account", { kind: "claude", name: "" });
  const action = useAction();
  useEffect(() => {
    if (!accounts.data?.some(a => a.kind !== "endpoint" && a.signedIn !== true && a.signin_command)) return;
    const timer = setInterval(accounts.reload, 3000); return () => clearInterval(timer);
  }, [accounts.data]);
  return <section className="screen"><div className="top"><h1>Accounts &amp; budgets</h1><span className="grow" /><Button variant={adding ? "secondary" : "primary"} onClick={() => setAdding(true)}>Add account</Button></div>
    <p className="muted">Each account is one budget. An old reading is shown as stale and stops deciding routing, unless it shows the account at its limit.</p><ErrorMessage error={accounts.error ?? limits.error} />
    {accountsModel(accounts.data ?? [], limits.data ?? []).map(a => { const status = executorStatus({ id: "", state: "ok", until: null, reason: null }, a); return <Card key={a.name}><div className="row"><h2>{a.name}</h2>{a.runners?.map(id => <span className="muted" key={id}>{executorLabel(id, accounts.data ?? [])}</span>)}<Pill tone={a.kind === "endpoint" ? status.tone : a.signedIn === true ? "good" : "warn"}>{a.kind === "endpoint" ? status.label : a.signedIn === true ? "Signed in" : a.signedIn === false ? "Signed out" : "Sign-in not confirmed"}</Pill></div>
      {a.windows.map(w => <div className="budget-window" key={w.name}><div className="row"><strong>{w.name}</strong><span>{w.usedPct == null ? "Usage unknown" : `${Math.round(w.usedPct)}% used`}</span>{w.resetsAt && <span className="muted">Resets {clock(w.resetsAt)}</span>}</div>{w.usedPct != null && <UsageMeter used={w.usedPct} label={`${a.name} ${w.name}`} />}</div>)}
      <p className="muted">{a.source} · {a.freshness}</p>{a.error && <p>{a.error}</p>}{a.hint && <p>{a.hint}</p>}{a.signin && <Signin command={a.signin} />}
      {a.connection && <dl className="facts"><dt>Host</dt><dd>{a.connection.base_url_host}</dd><dt>Key</dt><dd>{a.connection.key === "present" ? "Present" : "Missing"}</dd><dt>Models</dt><dd>{a.connection.models.map(m => m.name ?? m.id).join(", ")}</dd></dl>}
      <div className="row"><Button size="sm" variant="secondary" onClick={() => setRemove(a.name)}>Remove</Button></div></Card>; })}
    {accounts.data?.length === 0 && <p>No accounts yet. Add a Claude or Codex account, or <a href="#/executors/add">connect a model endpoint</a>.</p>}
    {adding && <Dialog title="Add account" close={() => setAdding(false)}><form onSubmit={e => { e.preventDefault(); void action.run("account.add", draft, () => { accounts.reload(); setAdding(false); clearDraft(); }); }}><label htmlFor="accounts-agent" className="field">Agent<select id="accounts-agent" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.currentTarget.value })}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label htmlFor="accounts-name" className="field">Account name<input id="accounts-name" required pattern="[a-z0-9][a-z0-9-]*" value={draft.name} onInput={e => setDraft({ ...draft, name: e.currentTarget.value })} /></label><div aria-live="polite"><ErrorMessage error={action.error} /></div><Button type="submit" variant="primary" disabled={action.busy}>Add account</Button></form></Dialog>}
    {remove && <Dialog title="Remove account?" close={() => setRemove(undefined)}><p>Remove {remove}? Accounts used by an executor or planner must be disconnected first.</p><div aria-live="polite"><ErrorMessage error={action.error} /></div><Button disabled={action.busy} onClick={() => { void action.run("account.remove", { name: remove }, () => { setRemove(undefined); accounts.reload(); limits.reload(); }); }}>Remove account</Button></Dialog>}
  </section>;
}
