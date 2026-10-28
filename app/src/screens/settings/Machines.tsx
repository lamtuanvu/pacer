import { useState } from "preact/hooks";
import type { Job } from "../../../../src/api/read-model/types";
import { hostCheckStepCopy } from "../../../../src/view-model/copy";
import { executorLabel } from "../../../../src/view-model/words";
import type { ConfigData } from "../../model/strategy";
import { TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { ChoiceCard } from "../../ds/Patterns";
import { SettingRow } from "../../ds/SettingRow";
import { SectionHeading } from "../../ds/SectionHeading";
import { CheckList } from "../../ds/Stepper";
import { Icon } from "../../ds/icons";
import { AgentMark } from "../../ds/AgentMark";
import { Pill } from "../../ds/Pill";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { Feedback, Field, ResourceState, Section, useOperation, useResource, words } from "./shared";

/** pacer host names: lower-case letters, digits and hyphens; "local" names this machine. */
export function hostNameProblem(name: string, taken: readonly string[] = []): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return "Use lower-case letters, digits and hyphens.";
  if (name === "local") return "“local” is reserved for this machine.";
  return taken.includes(name) ? "Another host already has this name." : null;
}
export const hostNameFrom = (alias: string) => alias.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
export const checkItems = (job: Job) => job.steps.map(step => ({ id: step.name, label: hostCheckStepCopy(step.name), state: step.state, note: step.detail }));

export function MachineSection({ initialData }: { initialData?: ConfigData }) {
  const { state } = useTaskContext(), snapshot = state.snapshot;
  const local = snapshot?.executors?.filter(e => !e.host) ?? [];
  return <Section id="machine" title="Machines" detail="Where tasks run. pacer drives remote hosts over your own SSH config and installs nothing on them.">
    <div className="u3-machines-grid">
      <section className="u3-machine-card" aria-labelledby="this-machine">
        <div className="u3-machine-header"><span className="u3-machine-tile"><Icon name="laptop" /></span>
        <div className="u3-machine-title"><SectionHeading variant="headline" id="this-machine">This Mac</SectionHeading>{snapshot?.service?.version && <span className="u3-muted">pacer {snapshot.service.version}</span>}</div>
          {snapshot?.machine && <Pill tone={snapshot.machine.used ? "good" : "neutral"}>Running {snapshot.machine.used} of {snapshot.machine.max}</Pill>}</div>
        <div className="u3-machine-body"><ThisMachine initialData={initialData} />
        {!!local.length && <SettingRow label="Executors here"><div className="u3-chips">{local.map(e => <span className="u3-chip" key={e.id} title={e.id}><AgentMark agent={e.agent} size={16} labelled={false} />{executorLabel(e.id)}</span>)}</div></SettingRow>}
      </div></section>
      <AddHost />
    </div>
    <RemoteHostList />
  </Section>;
}

function ThisMachine({ initialData }: { initialData?: ConfigData }) {
  const query = useResource("config.get", {}, initialData), action = useOperation(query.reload);
  const { state } = useTaskContext();
  const caps = state.snapshot?.executors?.filter(e => !e.host && e.slots?.max != null).map(e => `${executorLabel(e.id)} may use ${e.slots.max}`).join(" · ");
  const keys = query.data?.keys, value = keys?.["execution.local_max_tasks"]?.value;
  const terminal = String(keys?.["terminal.open"]?.value ?? ""), legacy = String(keys?.["terminal.app"]?.value ?? "Terminal");
  const choices = query.data?.terminalChoices ?? [{ value: "auto", label: "Automatic" }, { value: "terminal-app", label: "Terminal" }, { value: "iterm", label: "iTerm" }, { value: "ghostty", label: "Ghostty" }];
  const legacyPreset = keys?.["terminal.app"]?.source === "default" ? undefined : ({ Terminal: "terminal-app", iTerm: "iterm", Ghostty: "ghostty" } as Record<string, string>)[legacy];
  const selected = terminal || (legacyPreset && choices.some(c => c.value === legacyPreset) ? legacyPreset : "auto");
  const options = choices.some(c => c.value === selected) ? choices : [...choices, { value: selected, label: "Custom terminal (CLI)", disabled: true, reason: "Configured from the CLI" }];
  return <ResourceState resource={query}>
    <SettingRow label="Parallel tasks" description="Shared by every executor on this Mac">
      <div className="u3-actions"><TextInput className="u3-parallel-input" type="number" min="1" max="16" step="1" required value={String(value ?? 2)} disabled={action.busy}
        onChange={e => { if (e.currentTarget.validity.valid) void action.run("config.set", { key: "execution.local_max_tasks", value: Number(e.currentTarget.value) }); }} />{caps && <span className="u3-muted">{caps}</span>}</div>
    </SettingRow>
    <SettingRow label="Terminal for sessions" description="Where “Open elsewhere” goes">
      <ChoicePicker className="u3-terminal-picker" aria-label="Terminal for sessions" value={selected} options={options} disabled={action.busy} onValueChange={choice => void action.run("config.set", { key: "terminal.open", value: choice })} />
    </SettingRow>
    <Feedback action={action} />
  </ResourceState>;
}

/** Guided add: an alias from the user's SSH config, a pacer name, then a live connect-and-check list. */
export function AddHost({ initialAliases }: { initialAliases?: string[] }) {
  const { state } = useTaskContext(), aliases = useResource<string[]>("host.suggest", {}, initialAliases);
  // Adding only records the alias; the result that matters is the check, so adding stays quiet.
  const add = useOperation(undefined, { notifySuccess: false }), check = useOperation();
  const [ssh, setSsh] = useState(""), [name, setName] = useState(""), [added, setAdded] = useState("");
  const taken = state.snapshot?.hosts?.map(h => h.alias).filter(alias => alias !== added) ?? [];
  const problem = !ssh ? "Pick a host from your SSH config first." : hostNameProblem(name, taken);
  const none = aliases.data?.length === 0 && !added;
  const job = check.job, passed = job?.state === "passed" && job.target === added;
  const connect = async () => {
    if (problem) return;
    if (added !== name) { const result = await add.run("host.add", { alias: name, ssh }); if (!result) return; setAdded(name); }
    await check.run("host.check", { alias: name });
  };
  return <section className="u3-machine-card" aria-labelledby="add-host">
    <div className="u3-machine-header"><span className="u3-machine-tile"><Icon name="servers" /></span><div className="u3-machine-title"><SectionHeading variant="headline" id="add-host">Add a remote host</SectionHeading>
    <p className="u3-muted">Runs Codex or Claude Code on another machine over SSH</p></div></div>
    <div className="u3-host-body">
    {none ? <p>No new hosts in your SSH config. Add a <code>Host</code> entry to <code>~/.ssh/config</code>, then open this page again.</p> : <>
    <fieldset className="u3-fieldset" disabled={!!added}>
      <legend>1 · Pick a host from your SSH config</legend>
      <p className="u3-muted">Aliases from <code>~/.ssh/config</code> that pacer doesn’t use yet. It must connect without a password prompt.</p>
      <ResourceState resource={aliases}>
        <div className="u3-aliases">{aliases.data?.map(alias => <ChoiceCard layout="alias" key={alias} aria-pressed={ssh === alias} onClick={() => { setSsh(alias); setName(hostNameFrom(alias)); }}><code>{alias}</code></ChoiceCard>)}</div>
      </ResourceState>
    </fieldset>
    <Field label="2 · Name it in pacer" help={!ssh ? "Pick a host from your SSH config first." : undefined}><div className="u3-actions">
      <TextInput className="u3-host-name" value={name} required pattern="[a-z0-9][a-z0-9-]*" disabled={!!added || !ssh} aria-invalid={!!ssh && !!problem} onInput={e => setName(e.currentTarget.value)} />
      <span className="u3-muted">Lower-case letters, digits, hyphens.</span></div></Field>
    <div className="u3-heading"><strong>3 · Check it</strong>
      {!passed && <Button size="sm" variant="primary" busy={add.busy || check.busy} disabled={!!problem || !state.connected} onClick={() => void connect()}>{added ? "Check again" : "Connect and check"}</Button>}</div>
    {!state.connected && <p className="u3-muted">Reconnecting. Connect and check will be available when the service reconnects.</p>}
    {problem && ssh && !added && <p className="u3-muted">{problem}</p>}
    {job && <CheckList label={`Checks for ${added}`} items={checkItems(job)} />}
    {job?.error && <p role="alert">{job.error.message}{job.error.hint && ` · ${job.error.hint}`}</p>}
    {passed && <><p className="u3-muted" role="status">{added} is connected. Next, map the repositories it should work on and add its executors.</p>
      <div className="u3-actions"><ButtonLink variant="primary" href={`#/settings/hosts/${encodeURIComponent(added)}`}>Map repositories</ButtonLink><ButtonLink href={`#/settings/add-executor?host=${encodeURIComponent(added)}`}>Add an agent here</ButtonLink></div></>}
    <Feedback action={add} />
    <ErrorMessage error={check.error} />
    </>}
  </div></section>;
}

function RemoteHostList() {
  const { state } = useTaskContext(), hosts = state.snapshot?.hosts;
  if (!hosts?.length) return null;
  return <section aria-labelledby="remote-hosts" className="u3-section">
    <SectionHeading id="remote-hosts">Remote hosts</SectionHeading>
    <div className="u3-table-wrap"><table><thead><tr>{["Host", "Checks", "Parallel tasks", "Executors", ""].map(v => <th key={v}>{v}</th>)}</tr></thead>
      <tbody>{hosts.map(host => <tr key={host.alias}>
        <td data-label="Host"><strong>{host.alias}</strong><div><code>ssh {host.ssh}</code></div></td>
        <td data-label="Checks">{words(host.state)}</td>
        <td data-label="Parallel tasks">{host.running} of {host.maxTasks} running</td>
        <td data-label="Executors">{host.executors.length ? <div className="u3-chips">{host.executors.map(id => <span className="u3-chip" key={id} title={id}><AgentMark agent={id.split("#")[0]!} size={16} labelled={false} />{executorLabel(id)}</span>)}</div> : <span className="u3-muted">None yet</span>}</td>
        <td data-label="Actions"><TextAction href={`#/settings/hosts/${encodeURIComponent(host.alias)}`}>Manage<span className="sr-only"> {host.alias}</span></TextAction></td>
      </tr>)}</tbody></table></div>
  </section>;
}
