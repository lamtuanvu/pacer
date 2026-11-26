import { useState } from "preact/hooks";
import type { ExecutorRow } from "../../../../src/api/read-model/types";
import { accountLabel, accountNeedsSignIn, accountStatus, executorLabel } from "../../../../src/view-model/words";
import { Button, TextAction } from "../../ds/Button";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { Disclosure, TextInput } from "../../ds/Controls";
import { Stack } from "../../ds/Page";
import { SegmentedControl } from "../../ds/Patterns";
import { StatusPill } from "../../ds/StatusPill";
import { arkcliSignInRequired, type Account } from "../../model/accounts";
import type { ConfigData } from "../../model/strategy";
import { useTaskContext } from "../task-shared";
import { ImmediateSetting } from "./ImmediateSetting";
import { Feedback, Field, useOperation, useResource, useScoped } from "./shared";

/** The agent an account serves, as account.list reports it. */
export const accountAgent = (account: Account) => account.kind === "claude" ? "claude-code" : account.kind === "endpoint" ? "opencode" : account.kind;

/**
 * The account fact card of an agent: sign-in state and how to fix it, the agent's other accounts, the
 * spread/fill policy when the agent has several, and adding another account of the same kind.
 */
export function AgentAccount({ executor, accounts, config, reload }: { executor: ExecutorRow; accounts?: Account[]; config?: ConfigData; reload: () => void }) {
  const scoped = useScoped(), { state } = useTaskContext(), action = useOperation(reload);
  const account = accounts?.find(a => a.name === executor.account);
  const summary = state.snapshot?.accounts?.find(a => a.name === executor.account);
  const readiness = account ? { ...account, signedIn: summary?.signedIn ?? account.signedIn } : summary ? { kind: executor.agent === "opencode" ? "endpoint" : executor.agent, signedIn: summary.signedIn } : null;
  const siblings = (accounts ?? []).filter(a => a.name !== executor.account && accountAgent(a) === executor.agent);
  const kind = executor.agent === "claude-code" ? "claude" : executor.agent === "codex" ? "codex" : null;
  const used = (a: Account) => (state.snapshot?.accounts?.find(s => s.name === a.name)?.executors ?? a.runners ?? []).length > 0;
  return <Stack space="compact">
    <strong>{account ? accountLabel({ ...account, agent: executor.agent }) : executor.account}</strong>
    {readiness && <span><StatusPill status={accountStatus(readiness)} /></span>}
    {siblings.length > 0 && <span className="pc-agent-card__caption">{siblings.length} other {executorLabel(executor.agent)} {siblings.length === 1 ? "account" : "accounts"}: {siblings.map(a => `${a.name}${used(a) ? "" : " (not used)"}`).join(", ")}</span>}
    {account && arkcliSignInRequired(account) && <Disclosure className="pc-disclosure" summary={<>Fix Ark CLI sign-in<span className="sr-only"> for {accountLabel(account)}</span></>}>
      <Stack space="compact"><p>Sign in to BytePlus in a terminal, then check usage here.</p><div><code>arkcli auth login</code></div></Stack>
    </Disclosure>}
    {account && !arkcliSignInRequired(account) && readiness && accountNeedsSignIn(readiness) && <Disclosure className="pc-disclosure" summary={<>Fix sign-in<span className="sr-only"> for {accountLabel(account)}</span></>}>
      <p>Use the agent’s own sign-in to reconnect this account.</p>
      <Button size="sm" disabled={!!action.unavailable || action.busy} onClick={() => void action.run("account.signin", { name: account.name })}>Sign in</Button>
    </Disclosure>}
    {siblings.length > 0 && <AccountPolicy initialData={config} />}
    {kind && <AddAccount kind={kind} reload={reload} />}
    {executor.agent === "opencode" && <TextAction href={scoped("#/settings/add-executor")}>Connect another endpoint through Add agent</TextAction>}
    <Feedback action={action} />
  </Stack>;
}

function AddAccount({ kind, reload }: { kind: "claude" | "codex"; reload: () => void }) {
  const action = useOperation(reload);
  const [name, setName] = useState(""), [agent, setAgent] = useState<string>(kind);
  return <Disclosure className="pc-disclosure" summary="Add another account">
    <form className="pc-stack pc-stack--compact" onSubmit={event => { event.preventDefault(); void action.run("account.add", { name, kind: agent }, () => setName("")); }}>
      <Field label="Account name"><TextInput value={name} required pattern="[a-z0-9][a-z0-9-]*" onInput={event => setName(event.currentTarget.value)} /></Field>
      <Field label="Agent"><ChoicePicker value={agent} options={[{ value: "codex", agent: "codex", label: "Codex" }, { value: "claude", agent: "claude", label: "Claude Code" }]} onValueChange={setAgent} /></Field>
      <div className="u3-actions">
        <Button size="sm" type="submit" disabled={!!action.unavailable || action.busy}>Create account</Button>
        <Button size="sm" variant="quiet" disabled={!!action.unavailable || action.busy} onClick={() => void action.run("account.signin", { interactive: "account-add-orca" })}>Link an Orca account</Button>
      </div>
    </form>
    <Feedback action={action} />
  </Disclosure>;
}

/** The service's account policy (`pacing.accounts`, `pacing.fill_threshold`), saved immediately and independently of the page draft. */
export function AccountPolicy({ initialData }: { initialData?: ConfigData }) {
  const query = useResource<ConfigData>("config.get", {}, initialData), { state } = useTaskContext();
  const mode = query.data?.keys?.["pacing.accounts"]?.value, threshold = query.data?.keys?.["pacing.fill_threshold"]?.value;
  if (mode !== "spread" && mode !== "fill") return null;
  return <section className="pc-stack pc-stack--compact" aria-label="When an agent has several accounts">
    <span className="pc-agent-card__caption">When an agent has several accounts</span>
    <ImmediateSetting value={mode} operation={value => ({ op: "config.set", params: { key: "pacing.accounts", value } })} onSaved={query.reload}>{(value, change, busy) =>
      <SegmentedControl variant="board" label="Multiple accounts" value={value} disabled={busy || !state.connected} options={[{ value: "spread", label: "Spread evenly" }, { value: "fill", label: "Fill one, then the next" }]} onChange={change} />}</ImmediateSetting>
    <span className="pc-agent-card__caption">Fill one, then the next moves on at {String(threshold ?? 90)}% used.</span>
    {mode === "fill" && threshold !== undefined && <ImmediateSetting value={String(threshold)} operation={value => ({ op: "config.set", params: { key: "pacing.fill_threshold", value: Number(value) } })} onSaved={query.reload}>{(value, change, busy) =>
      <label className="u3-fill">Move to the next account at <TextInput aria-label="Account fill threshold" type="number" min="50" max="100" step="1" required value={value} disabled={busy || !state.connected} onChange={event => { if (event.currentTarget.validity.valid) change(event.currentTarget.value); }} />% used</label>}</ImmediateSetting>}
    {!state.connected && <p className="u3-muted">Reconnecting. Account policy changes will be available when the service reconnects.</p>}
  </section>;
}
