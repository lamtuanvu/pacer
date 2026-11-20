import { ImmediateSetting } from "./ImmediateSetting";
import { markAgent } from "../../../../src/view-model/agents";
import { useState } from "preact/hooks";
import { spendCopy } from "../../../../src/view-model/copy";
import { accountLabel, accountNeedsSignIn, accountStatus, executorLabel, paceStatus } from "../../../../src/view-model/words";
import { usageView } from "../../../../src/view-model/usage";
import type { AccountSummary } from "../../../../src/api/read-model/types";
import { Disclosure, TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { StatusPill } from "../../ds/StatusPill";
import { UsageMeter } from "../../ds/UsageMeter";
import { AgentMark } from "../../ds/AgentMark";
import { SegmentedControl } from "../../ds/Patterns";
import { Icon } from "../../ds/icons";
import type { ConfigData } from "../../model/strategy";
import { SectionHeading } from "../../ds/SectionHeading";
import { Stack } from "../../ds/Page";
import { Button, IconButton, TextAction } from "../../ds/Button";
import { accountRecord, arkcliSignInRequired, type Account } from "../../model/accounts";
import { useTaskContext } from "../task-shared";
import { AgentsIntro } from "./Executors";
import { Feedback, Field, ResourceState, SettingsBoard, useOperation, useResource, useScoped } from "./shared";

import { AccountUsage } from "./AccountUsage";

const agentOf = (account: Account, summary?: AccountSummary) => summary?.agent ?? (account.kind === "claude" ? "claude-code" : account.kind === "endpoint" ? "opencode" : account.kind);

export function AccountsSection({ initialData, initialConfig }: { initialData?: Account[]; initialConfig?: ConfigData }) {
  const scoped = useScoped();
  const query = useResource<Account[]>("account.list", {}, initialData),
    action = useOperation(query.reload),
    { state } = useTaskContext();
  const [adding, setAdding] = useState(false), [name, setName] = useState(""), [kind, setKind] = useState("codex"),
    [openActions, setOpenActions] = useState<string | null>(null);
  return (
    <SettingsBoard id="accounts" title="Agents" caption="Who plans, who executes, and what each one is allowed to use."
      >
      <AgentsIntro tab="accounts" actions={<><Button onClick={() => void action.run("account.signin", {interactive:"account-add-orca"})} disabled={!!action.unavailable}>Link an Orca account</Button><Button variant="primary" aria-expanded={adding} onClick={() => setAdding(v => !v)}>Add account</Button></>}/>
      <div className="u3-accounts-info"><Icon name="lock"/><span>An account is where quota comes from. pacer never reads or copies an agent's own sign-in. Endpoint keys stay in your keychain and are used by reference.</span></div>
      <ResourceState resource={query} empty="No accounts yet. Add an account to get started.">
        <div className="u3-table-wrap u3-agents-table">
          <div className="u3-accounts-scroll"><table>
            <thead><tr>{["Account", "Sign-in", "Quota", "Status", "Used by"].map(v => <th key={v} scope="col">{v}</th>)}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {query.data?.map(account => {
                const summary = state.snapshot?.accounts?.find(a => a.name === account.name),
                  readiness = { ...account, signedIn: summary?.signedIn ?? account.signedIn },
                  record = accountRecord(account, summary),
                  view = usageView(record, state.snapshot?.at ?? Date.now() / 1000),
                  historical = record?.freshness === "historical",
                  freshness = view.freshness,
                  users = summary?.executors ?? account.runners ?? [],
                  spend = spendCopy(record?.spend?.usdWeek ?? null, record?.spend?.capUsdWeek ?? null),
                  status = record?.error ? {...paceStatus("unknown"), label: "Usage check failed", tone: "warn" as const}
                    : readiness.signedIn === true && record ? paceStatus(record.verdict)
                    : accountStatus(readiness),
                  hasAction = arkcliSignInRequired(account) || accountNeedsSignIn(readiness),
                  expanded = hasAction && openActions === account.name, actionsId = `account-actions-${encodeURIComponent(account.name)}`;
                return (
                  <tr key={account.name}>
                    <td data-label="Account">
                      <div className="u3-agent"><AgentMark agent={markAgent(account.runners?.[0] ?? agentOf(account, summary),account.name)} size={24} labelled={false} />
                        <div><strong>{accountLabel({...account,agent:agentOf(account,summary)})}</strong>
                          <div className="u3-muted">{account.kind === "endpoint" ? "Model endpoint" : executorLabel(agentOf(account))}</div></div></div>
                    </td>
                    <td data-label="Sign-in"><span>{readiness.signedIn===true?'Signed in':readiness.signedIn===false?'Signed out':'Unknown'}</span><div className="u3-muted">{account.kind==='endpoint'?'Model endpoint':`${executorLabel(agentOf(account))}’s own sign-in`}</div></td>
                    <td data-label="Quota">
                      {view.meter !== null && <UsageMeter used={view.meter} pace={historical ? null : summary?.pacePct ?? null} tone={historical ? "neutral" : view.tone} size="slim" text="none" label={`${accountLabel(account)} usage`} stale={historical} />}
                      <div className="u3-muted">{[spend || view.summary, view.reset.startsWith("resets ") ? view.reset : null].filter(Boolean).join(" · ")}{freshness && ` · ${freshness}`}</div>
                      <div className="u3-muted">{view.source}</div>
                    </td>
                    <td data-label="Status">
                      <StatusPill status={status} />
                    </td>
                    <td data-label="Used by">
                      {users.length ? <div className="u3-chips">{users.map(id => <span className="u3-chip" key={id} title={executorLabel(id)}><AgentMark agent={markAgent(id, account.name)} size={16} />{executorLabel(id)}</span>)}</div> : <span className="u3-muted">Not used</span>}
                    </td>
                    <td data-label="Actions" className={expanded ? "u3-account-actions--open" : undefined}>
                      <AccountUsage account={account} reload={query.reload} sourceError={record?.error?.message}/>
                      {hasAction && <>
                        <IconButton icon="more" size="sm" variant="quiet" aria-label={`More actions for ${accountLabel(account)}`} aria-expanded={expanded} aria-controls={actionsId} onClick={() => setOpenActions(expanded ? null : account.name)} />
                        <div id={actionsId} hidden={!expanded}>
                          {arkcliSignInRequired(account) ? (
                            <Disclosure className="pc-disclosure" summary={<>Fix Ark CLI sign-in<span className="sr-only"> for {accountLabel(account)}</span></>}>
                              <Stack space="compact"><p>Sign in to BytePlus in a terminal, then check usage here.</p><div><code>arkcli auth login</code></div></Stack>
                            </Disclosure>
                          ) : accountNeedsSignIn(readiness) ? (
                            <Disclosure className="pc-disclosure" summary={<>Fix sign-in<span className="sr-only"> for {accountLabel(account)}</span></>}>
                              <p>Use the agent’s own sign-in to reconnect this account.</p>
                              <Button size="sm" disabled={!!action.unavailable || (action.busy)} onClick={() => void action.run("account.signin", { name: account.name })}>Sign in</Button>
                            </Disclosure>
                          ) : null}
                        </div>
                      </>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </div>
      </ResourceState>
      {adding && (
        <form className="pc-card" onSubmit={e => { e.preventDefault(); void action.run("account.add", { name, kind }, () => { setAdding(false); setName(""); }); }}>
          <div className="u3-settings-grid">
            <Field label="Account name"><TextInput value={name} required pattern="[a-z0-9][a-z0-9-]*" onInput={e => setName(e.currentTarget.value)} /></Field>
            <Field label="Agent"><ChoicePicker value={kind} options={[{ value: "codex", agent: "codex", label: "Codex" }, { value: "claude", agent: "claude", label: "Claude Code" }]} onValueChange={setKind} /></Field>
          </div>
          <Button type="submit" disabled={!!action.unavailable || (action.busy)}>Create account</Button>
          <p><TextAction href={scoped("#/settings/add-executor")}>Connect an API endpoint through Add agent</TextAction></p>
        </form>
      )}
      <AccountPolicy initialData={initialConfig}/>
      <Feedback action={action} />
    </SettingsBoard>
  );
}

/** The service's existing account policy, saved independently from executor limits. */
export function AccountPolicy({initialData}:{initialData?:ConfigData}) {
  const query=useResource<ConfigData>('config.get',{},initialData), {state}=useTaskContext();
  const mode=query.data?.keys?.['pacing.accounts']?.value, threshold=query.data?.keys?.['pacing.fill_threshold']?.value;
  if(mode!=='spread'&&mode!=='fill')return null;
  return <section className="u3-account-policy" aria-label="When an agent has several accounts"><div><SectionHeading>When an agent has several accounts</SectionHeading><p className="u3-muted">Choose how work uses an agent's accounts.</p></div><div className="u3-account-policy-controls"><ImmediateSetting value={mode} operation={value => ({op:"config.set",params:{key:"pacing.accounts",value}})} onSaved={query.reload}>{(value, change, busy) => <SegmentedControl variant="board" label="Multiple accounts" value={value} disabled={busy||!state.connected} options={[{value:"spread",label:"Spread evenly"},{value:"fill",label:"Fill one, then the next"}]} onChange={change}/>}</ImmediateSetting><p className="u3-muted">Fill one, then the next moves on at {threshold ?? 90}% used.</p>{mode==='fill'&&threshold!==undefined&&<ImmediateSetting value={String(threshold)} operation={value => ({op:"config.set",params:{key:"pacing.fill_threshold",value:Number(value)}})} onSaved={query.reload}>{(value, change, busy) => <label className="u3-fill">Move to the next account at <TextInput aria-label="Account fill threshold" type="number" min="50" max="100" step="1" required value={value} disabled={busy||!state.connected} onChange={event => {if(event.currentTarget.validity.valid)change(event.currentTarget.value);}}/>% used</label>}</ImmediateSetting>}{!state.connected&&<p className="u3-muted">Reconnecting. Account policy changes will be available when the service reconnects.</p>}</div></section>;
}
