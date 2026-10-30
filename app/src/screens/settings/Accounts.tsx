import { markAgent } from "../../../../src/view-model/agents";
import { useState } from "preact/hooks";
import { clock } from "../../../../src/view-model/time";
import { spendCopy } from "../../../../src/view-model/copy";
import { accountLabel, accountNeedsSignIn, accountStatus, executorLabel, paceStatus } from "../../../../src/view-model/words";
import { accountUsageFreshness } from "../../../../src/view-model/capacity";
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
import { accountQuotaLabel, accountObservation, arkcliSignInRequired, type Account } from "../../model/accounts";
import { useTaskContext } from "../task-shared";
import { AgentsIntro } from "./Executors";
import { Feedback, Field, ResourceState, SettingsBoard, useOperation, useResource, useScoped } from "./shared";

import { AccountUsage } from "./AccountUsage";

const agentOf = (account: Account, summary?: AccountSummary) => summary?.agent ?? (account.kind === "claude" ? "claude-code" : account.kind === "endpoint" ? "opencode" : account.kind);

/** Usage in words; a missing reading says so rather than showing zero. */
export function accountUsageWords(summary?: AccountSummary): string {
  if (!summary) return "Usage unknown";
  const spend = spendCopy(summary.spendUsdWeek, summary.capUsdWeek);
  if (spend) return spend;
  if (summary.usedPct == null) return "No usage reported";
  const window = summary.window === "weekly" || summary.window === "week" ? "week" : summary.window ?? "window";
  return `${Math.round(summary.usedPct)}% of ${window}${summary.resetsAt ? ` · resets ${clock(summary.resetsAt, Date.now() / 1000)}` : ""}`;
}

export function AccountsSection({ initialData, initialConfig }: { initialData?: Account[]; initialConfig?: ConfigData }) {
  const scoped = useScoped();
  const query = useResource<Account[]>("account.list", {}, initialData),
    action = useOperation(query.reload),
    { state } = useTaskContext();
  const [adding, setAdding] = useState(false), [name, setName] = useState(""), [kind, setKind] = useState("codex"),
    [openActions, setOpenActions] = useState<string | null>(null);
  return (
    <SettingsBoard id="accounts" title="Agents" caption="Who plans, who executes, and what each one is allowed to use."
      actions={<>
        <Button onClick={() => void action.run("account.signin", { interactive: "account-add-orca" })}>Link an Orca account</Button>
        <Button variant="primary" aria-expanded={adding} onClick={() => setAdding(v => !v)}>Add account</Button>
      </>}>
      <AgentsIntro tab="accounts" />
      <div className="u3-accounts-info"><Icon name="lock"/><span>An account is where quota comes from. pacer never reads or copies an agent's own sign-in.</span></div>
      <ResourceState resource={query} empty="No accounts yet. Add an account to get started.">
        <div className="u3-table-wrap u3-agents-table">
          <div className="u3-accounts-scroll"><table>
            <thead><tr>{["Account", "Sign-in", "Quota", "Status", "Used by"].map(v => <th key={v} scope="col">{v}</th>)}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {query.data?.map(account => {
                const summary = state.snapshot?.accounts?.find(a => a.name === account.name),
                  readiness = { ...account, signedIn: summary?.signedIn ?? account.signedIn },
                  quotaLabel = accountQuotaLabel(account, summary),
                  observation = accountObservation(account, summary), usage = observation?.usage, observedAt = usage?.capturedAt,
                  freshness = usage && accountUsageFreshness(usage), users = summary?.executors ?? account.runners ?? [],
                  pace = paceStatus(usage?.verdict ?? "unknown"),
                  status = quotaLabel ? accountStatus({}) : observation?.error ? {...paceStatus("unknown"), label: "Usage check failed", tone: "warn" as const}
                    : readiness.signedIn === true && usage
                      ? pace.label === "Usage unknown" && (usage.usedPct != null || usage.spendUsdWeek != null)
                        ? {...pace, label: freshness ? "Historical usage" : "Usage observed"} : pace
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
                      {usage?.usedPct != null && <UsageMeter used={usage.usedPct} pace={usage.pacePct??null} tone={paceStatus(usage.verdict).tone} size="slim" text="none" label={`${accountLabel(account)} usage`} stale={!!freshness} />}
                      <div className="u3-muted">{quotaLabel ?? accountUsageWords(usage)}{freshness && ` · ${freshness}`}</div>
                      {!quotaLabel && <div className="u3-muted">{observedAt == null ? "No observation time available" : `Last observed ${clock(observedAt, Date.now()/1000)}${usage?.stale !== false ? " · historical reading" : ""}`}</div>}
                    </td>
                    <td data-label="Status">
                      <StatusPill status={status} />

                    </td>
                    <td data-label="Used by">
                      {users.length ? <div className="u3-chips">{users.map(id => <span className="u3-chip" key={id} title={executorLabel(id)}><AgentMark agent={id.split(/[#@]/)[0]!} size={16} />{executorLabel(id)}</span>)}</div> : <span className="u3-muted">Not used</span>}
                    </td>
                    <td data-label="Actions" className={expanded ? "u3-account-actions--open" : undefined}>
                      <AccountUsage account={account} reload={query.reload} sourceError={observation?.error}/>
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
                              <Button size="sm" disabled={action.busy} onClick={() => void action.run("account.signin", { name: account.name })}>Sign in</Button>
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
            <Field label="Agent"><ChoicePicker value={kind} options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }]} onValueChange={setKind} /></Field>
          </div>
          <Button type="submit" disabled={action.busy}>Create account</Button>
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
  const query=useResource<ConfigData>('config.get',{},initialData), action=useOperation(query.reload), {state}=useTaskContext();
  const mode=query.data?.keys?.['pacing.accounts']?.value, threshold=query.data?.keys?.['pacing.fill_threshold']?.value;
  if(mode!=='spread'&&mode!=='fill')return null;
  return <section className="u3-account-policy" aria-label="When an agent has several accounts"><div><SectionHeading>When an agent has several accounts</SectionHeading><p className="u3-muted">Choose how work uses an agent's accounts.</p></div><div className="u3-account-policy-controls"><SegmentedControl variant="board" label="Multiple accounts" value={mode} disabled={action.busy||!state.connected} options={[{value:'spread',label:'Spread evenly'},{value:'fill',label:'Fill one, then the next'}]} onChange={value=>void action.run('config.set',{key:'pacing.accounts',value})}/>{mode==='fill'&&threshold!==undefined&&<label className="u3-fill">Move to the next account at <TextInput aria-label="Account fill threshold" type="number" min="50" max="100" step="1" required value={String(threshold)} disabled={action.busy||!state.connected} onChange={e=>{if(e.currentTarget.validity.valid)void action.run('config.set',{key:'pacing.fill_threshold',value:Number(e.currentTarget.value)});}}/>% used</label>}{!state.connected&&<p className="u3-muted">Reconnecting. Account policy changes will be available when the service reconnects.</p>}<Feedback action={action}/></div></section>;
}
