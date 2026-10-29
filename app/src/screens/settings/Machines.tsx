import { useEffect, useRef, useState } from "preact/hooks";
import type { Job } from "../../../../src/api/read-model/types";
import { hostCheckStepCopy } from "../../../../src/view-model/copy";
import { executorLabel } from "../../../../src/view-model/words";
import { machineHardCap } from "../../../../src/view-model/capacity";
import type { ClientMachine } from "../../../../src/view-model/snapshot";
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
import { Alert } from "../../ds/Alert";
import { useDialogs } from "../../ds/useDialogs";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { Feedback, Field, ResourceState, Segment, SettingsBoard, useOperation, useResource, words, useScoped } from "./shared";

/** pacer host names: lower-case letters, digits and hyphens; "local" names this machine. */
export function hostNameProblem(name: string, taken: readonly string[] = []): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return "Use lower-case letters, digits and hyphens.";
  if (name === "local") return "“local” is reserved for this machine.";
  return taken.includes(name) ? "Another host already has this name." : null;
}
export const hostNameFrom = (alias: string) => alias.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
export const checkItems = (job: Job) => job.steps.map(step => ({ id: step.name, label: hostCheckStepCopy(step.name), state: step.state, note: step.detail }));

const BACKEND_CHOICES = [{ value: "direct", label: "Direct" }, { value: "orca", label: "Orca" }];
/** Which backend runs delegated tasks. Orca hosts interactive launches; everything else runs directly. */
export function TaskBackendField({ value, source, disabled, run }: { value: unknown; source?: string; disabled?: boolean; run: (op: string, params: unknown) => unknown }) {
  return <SettingRow variant="board" label="Task backend" description={<>Orca runs interactive tasks as supervised workers in Orca terminals. Headless tasks, and any task when Orca isn't running or the agent isn't supported, run directly.{source?.startsWith("env") && <> PACER_BACKEND overrides the saved setting.</>}</>}>
    <ChoicePicker className="u3-terminal-picker" aria-label="Task backend" value={value === "orca" ? "orca" : "direct"} options={BACKEND_CHOICES} disabled={disabled} onValueChange={choice => void run("config.set", { key: "execution.backend", value: choice })} />
  </SettingRow>;
}

export function MachineSection({ initialData }: { initialData?: ConfigData }) {
  const { state } = useTaskContext(), snapshot = state.snapshot;
  const local = snapshot?.executors?.filter(e => !e.host) ?? [];
  return <SettingsBoard id="machine" title="Machines" caption="Where tasks run. pacer drives remote hosts over your own SSH config and installs nothing on them.">
    <div className="u3-machines-grid">
      <section className="u3-machine-card" aria-labelledby="this-machine">
        <div className="u3-machine-header"><span className="u3-machine-tile"><Icon name="laptop" /></span>
        <div className="u3-machine-title"><SectionHeading variant="headline" id="this-machine">This Mac</SectionHeading>{snapshot?.service?.version && <span className="u3-muted">pacer {snapshot.service.version}</span>}</div>
          {snapshot?.machine && <Pill tone={snapshot.machine.used ? "good" : "neutral"}>Running {snapshot.machine.used}{machineHardCap(snapshot.machine) !== null && <> of {machineHardCap(snapshot.machine)}</>}</Pill>}</div>
        <div className="u3-machine-body"><ThisMachine initialData={initialData} />
        {!!local.length && <SettingRow variant="board" label="Executors here"><div className="u3-chips">{local.map(e => <span className="u3-chip" key={e.id} title={e.id}><AgentMark agent={e.agent} size={16} labelled={false} />{executorLabel(e.id)}</span>)}</div></SettingRow>}
      </div></section>
      <AddHost />
    </div>
    <RemoteHostList />
  </SettingsBoard>;
}

type MachineDraft = { cap: "unlimited" | "limit"; max: string; pressure: string; load: "off" | "limit"; loadLimit: string; launch: string; terminal: string; backend: string };
const MACHINE_KEYS = { max: "execution.local_max_tasks", pressure: "execution.local_memory_pressure_limit", load: "execution.local_load_limit", launch: "execution.launch_mode", terminal: "terminal.open", backend: "execution.backend" } as const;
function terminalPreference(config?: ConfigData) {
  const keys = config?.keys, terminal = String(keys?.["terminal.open"]?.value ?? ""), legacy = String(keys?.["terminal.app"]?.value ?? "Terminal");
  const choices = config?.terminalChoices ?? [{ value: "auto", label: "Automatic" }, { value: "terminal-app", label: "Terminal" }, { value: "iterm", label: "iTerm" }, { value: "ghostty", label: "Ghostty" }];
  const legacyPreset = keys?.["terminal.app"]?.source === "default" ? undefined : ({ Terminal: "terminal-app", iTerm: "iterm", Ghostty: "ghostty" } as Record<string, string>)[legacy];
  const selected = terminal || (legacyPreset && choices.some(c => c.value === legacyPreset) ? legacyPreset : "auto");
  const options = choices.some(c => c.value === selected) ? choices : [...choices, { value: selected, label: "Custom terminal (CLI)", disabled: true, reason: "Configured from the CLI" }];
  return { selected, options };
}
function machineDraft(config: ConfigData | undefined): MachineDraft {
  const max = config?.keys[MACHINE_KEYS.max]?.value, load = config?.keys[MACHINE_KEYS.load]?.value;
  return {
    cap: typeof max === "number" ? "limit" : "unlimited", max: typeof max === "number" ? String(max) : "",
    pressure: String(config?.keys[MACHINE_KEYS.pressure]?.value ?? "critical"),
    load: typeof load === "number" ? "limit" : "off", loadLimit: typeof load === "number" ? String(load) : "",
    launch: String(config?.keys[MACHINE_KEYS.launch]?.value ?? "interactive"), terminal: terminalPreference(config).selected,
    backend: config?.keys[MACHINE_KEYS.backend]?.value === "orca" ? "orca" : "direct",
  };
}
/** Each saved setting, how a draft spells it, and the draft fields it covers. */
const MACHINE_FIELDS = [
  { key: MACHINE_KEYS.max, value: (d: MachineDraft) => d.cap === "unlimited" ? "unlimited" : Number(d.max), pick: (d: MachineDraft) => ({ cap: d.cap, max: d.max }) },
  { key: MACHINE_KEYS.pressure, value: (d: MachineDraft) => d.pressure, pick: (d: MachineDraft) => ({ pressure: d.pressure }) },
  { key: MACHINE_KEYS.load, value: (d: MachineDraft) => d.load === "off" ? "off" : Number(d.loadLimit), pick: (d: MachineDraft) => ({ load: d.load, loadLimit: d.loadLimit }) },
  { key: MACHINE_KEYS.launch, value: (d: MachineDraft) => d.launch, pick: (d: MachineDraft) => ({ launch: d.launch }) },
  { key: MACHINE_KEYS.terminal, value: (d: MachineDraft) => d.terminal, pick: (d: MachineDraft) => ({ terminal: d.terminal }) },
  // Last, so a backend warning (Orca not running) stays the save's feedback.
  { key: MACHINE_KEYS.backend, value: (d: MachineDraft) => d.backend, pick: (d: MachineDraft) => ({ backend: d.backend }) },
] as const;
/** The config.set values a draft stands for; only keys that differ from the draft's base are written. */
function machineChanges(base: MachineDraft, draft: MachineDraft): { key: string; value: string | number }[] {
  return MACHINE_FIELDS.filter(f => f.value(draft) !== f.value(base)).map(f => ({ key: f.key, value: f.value(draft) }));
}
/** Keys the draft would write whose saved value changed since the draft's base. */
function machineConflicts(base: MachineDraft, draft: MachineDraft, saved: MachineDraft): string[] {
  return MACHINE_FIELDS.filter(f => f.value(draft) !== f.value(base) && f.value(saved) !== f.value(base)).map(f => f.key);
}
/**
 * Follow new saved values without losing edits: a field the user has not edited, or whose
 * edit now matches the saved value, takes the saved value. Edited fields keep their base,
 * so a later save can see that the saved value moved underneath them.
 */
function rebaseMachine(form: { base: MachineDraft; draft: MachineDraft }, saved: MachineDraft) {
  let { base, draft } = form;
  for (const f of MACHINE_FIELDS) {
    if (f.value(draft) === f.value(base)) { base = { ...base, ...f.pick(saved) }; draft = { ...draft, ...f.pick(saved) }; }
    else if (f.value(draft) === f.value(saved)) base = { ...base, ...f.pick(saved) };
  }
  return { base, draft };
}
const PRESSURE_WORDS: Record<string, string> = { normal: "normal", warning: "warning", critical: "critical" };
/** What the machine guard sees now, in plain words. */
export function machineNow(machine: ClientMachine | undefined): string | null {
  if (!machine) return null;
  const pressure = machine.memoryPressure === undefined ? null : machine.memoryPressure === null ? "memory pressure unavailable" : `memory pressure ${PRESSURE_WORDS[machine.memoryPressure]}`;
  const load = machine.loadPerCore == null ? null : `load ${Math.round(machine.loadPerCore * 10) / 10} per core`;
  const waits = machine.open === false && machine.detail ? `new tasks wait: ${machine.detail}` : null;
  // The running count is the card's badge; it appears once per screen (UI-15).
  return [pressure, load, waits].filter(Boolean).join(" · ") || null;
}

/** Every field on this machine is drafted together and written only through the save bar. */
function ThisMachine({ initialData }: { initialData?: ConfigData }) {
  const query = useResource("config.get", {}, initialData), action = useOperation(query.reload);
  const { state, api } = useTaskContext(), dialogs = useDialogs();
  const caps = state.snapshot?.executors?.filter(e => !e.host && e.slots?.max != null).map(e => `${executorLabel(e.id)} may use ${e.slots.max}`).join(" · ");
  const keys = query.data?.keys;
  const saved = machineDraft(query.data), savedKey = JSON.stringify(saved);
  // Rebased in render too, so a new saved value never shows stale for a frame before the effect stores it.
  const [form, setForm] = useState({ base: saved, draft: saved }), { base, draft } = rebaseMachine(form, saved);
  const changes = machineChanges(base, draft), dirty = changes.length > 0;
  // A conflict also covers an edit reverted after the saved value moved: the base is stale.
  const conflict = machineConflicts(base, draft, saved).length > 0 || MACHINE_FIELDS.some(f => f.value(base) !== f.value(saved));
  // The same predicate as config.set, so Save is never offered for a value the service refuses.
  const capError = draft.cap === "limit" && !(/^\d+$/.test(draft.max) && Number.isSafeInteger(Number(draft.max)) && Number(draft.max) >= 1) ? "Enter a whole number of at least 1." : undefined;
  const loadError = draft.load === "limit" && !(/^\d+(\.\d+)?$/.test(draft.loadLimit) && Number(draft.loadLimit) > 0) ? "Enter a load per core greater than 0, such as 3." : undefined;
  useEffect(() => { setForm(f => rebaseMachine(f, saved)); }, [savedKey]);
  const edit = (patch: Partial<MachineDraft>) => setForm(f => ({ ...f, draft: { ...f.draft, ...patch } }));
  // Discard and Save disable themselves; the save status keeps keyboard focus in the form.
  const status = useRef<HTMLSpanElement>(null), saveButton = useRef<HTMLButtonElement>(null);
  const keepFocus = (wrote: boolean) => {
    const el = document.activeElement, lost = !el || el === document.body;
    if (wrote) { if (lost || el.closest(".u3-save-bar")) status.current?.focus(); return; }
    // A failed write leaves Save enabled for a retry; it was disabled while busy, so focus returns once it re-renders.
    if (lost || el === saveButton.current) setTimeout(() => (saveButton.current?.disabled ? status.current : saveButton.current)?.focus());
  };
  const [readError, setReadError] = useState<unknown>();
  const reset = () => { setReadError(undefined); setForm({ base: saved, draft: saved }); status.current?.focus(); };
  const save = async () => {
    // Re-read before writing: a key changed elsewhere since this draft began is not overwritten.
    // Without a fresh read there is no conflict check, so the draft stays unsaved.
    setReadError(undefined);
    let latest: ConfigData;
    try { latest = await api.call<ConfigData>("config.get", {}); } catch (e) { setReadError(e); return; }
    query.setData(latest);
    if (machineConflicts(base, draft, machineDraft(latest)).length) return;
    let wrote = true;
    for (const change of changes) {
      if (!(await action.run("config.set", change))) { wrote = false; break; }
      // Record the written value as saved now so the form does not flash the old one.
      latest = { ...latest, keys: { ...latest.keys, [change.key]: { ...latest.keys[change.key], value: change.value } } };
      query.setData(latest);
    }
    keepFocus(wrote);
  };
  // Pressure and load change without any setting changing: re-read the guard state while open.
  // A failed poll keeps the last reading rather than replacing the form with an error.
  const [live, setLive] = useState<ConfigData["machine"]>();
  useEffect(() => {
    let active = true;
    const poll = () => void api.call<ConfigData>("config.get", {}).then(r => { if (active) setLive(r.machine); }, () => {});
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [api]);
  const now = machineNow(state.snapshot?.machine && { ...state.snapshot.machine, ...query.data?.machine, ...live });
  const { options } = terminalPreference(query.data);
  return <ResourceState resource={query}>
    {now && <p className="u3-muted" role="status">Now: {now}</p>}
    <SettingRow variant="board" label="Parallel tasks" description="Shared by every executor on this Mac. Without a limit, new tasks start until the machine is under memory pressure or over the load limit. Tasks already running are never stopped.">
      <div className="u3-actions">
        <Segment label="Parallel task limit" value={draft.cap} options={[{ value: "unlimited", label: "No limit" }, { value: "limit", label: "Limit to N" }]} disabled={action.busy}
          onChange={cap => edit({ cap: cap as MachineDraft["cap"], max: cap === "limit" && !draft.max ? "4" : draft.max })} />
        {draft.cap === "limit" && <TextInput className="u3-parallel-input" type="number" min="1" step="1" required aria-invalid={!!capError} value={draft.max} onInput={e => edit({ max: e.currentTarget.value })} />}
        {caps && <span className="u3-muted">{caps}</span>}
      </div>
      {capError && <small className="pc-field__error" role="alert">{capError}</small>}
    </SettingRow>
    <SettingRow variant="board" label="Hold new tasks at memory pressure" description="macOS memory pressure. New local tasks wait while pressure is at or above this level. Off ignores memory pressure.">
      <ChoicePicker className="u3-terminal-picker" aria-label="Hold new tasks at memory pressure" value={draft.pressure} options={[{ value: "critical", label: "Critical" }, { value: "warning", label: "Warning" }, { value: "off", label: "Off" }]} disabled={action.busy} onValueChange={pressure => edit({ pressure })} />
    </SettingRow>
    <SettingRow variant="board" label="Load limit per CPU core" description="1-minute load average divided by CPU cores. New local tasks wait while load is over the limit.">
      <div className="u3-actions">
        <Segment label="Load limit" value={draft.load} options={[{ value: "off", label: "Off" }, { value: "limit", label: "Limit" }]} disabled={action.busy}
          onChange={load => edit({ load: load as MachineDraft["load"], loadLimit: load === "limit" && !draft.loadLimit ? "3" : draft.loadLimit })} />
        {draft.load === "limit" && <TextInput className="u3-parallel-input" type="number" min="0.1" step="0.1" required aria-invalid={!!loadError} value={draft.loadLimit} onInput={e => edit({ loadLimit: e.currentTarget.value })} />}
      </div>
      {loadError && <small className="pc-field__error" role="alert">{loadError}</small>}
    </SettingRow>
    <SettingRow variant="board" label="Delegated task launch" description="Interactive runs open in the agent's terminal UI and finish when the agent reports its result. Headless runs the agent's non-interactive CLI. A runner's own session setting overrides this.">
      <ChoicePicker className="u3-terminal-picker" aria-label="Delegated task launch" value={draft.launch} options={[{ value: "interactive", label: "Interactive" }, { value: "headless", label: "Headless" }]} disabled={action.busy} onValueChange={launch => edit({ launch })} />
    </SettingRow>
    <TaskBackendField value={draft.backend} source={keys?.[MACHINE_KEYS.backend]?.source} disabled={action.busy} run={(_op, params) => edit({ backend: String((params as { value: unknown }).value) })} />
    <SettingRow variant="board" label="Terminal for sessions" description="Where “Open elsewhere” goes">
      <ChoicePicker className="u3-terminal-picker" aria-label="Terminal for sessions" value={draft.terminal} options={options} disabled={action.busy} onValueChange={terminal => edit({ terminal })} />
    </SettingRow>
    {conflict && <Alert tone="warning" title="Settings changed elsewhere">
      Your draft is preserved. Reload the saved settings before making further changes.{" "}
      <Button size="sm" onClick={async () => { if (await dialogs.confirm("Discard this draft and load the latest saved settings?", "Reload saved settings", "Reload")) reset(); }}>Reload saved settings</Button>
    </Alert>}
    <div className="u3-save-bar">
      {/* Polite status; the conflict Alert already announces "Settings changed elsewhere". */}
      <span ref={status} className="u3-save-status" tabIndex={-1} role="status" aria-live="polite">{dirty ? "Unsaved changes" : conflict ? <span aria-hidden="true">Settings changed elsewhere</span> : "All changes saved"}</span>
      <div className="u3-actions">
        <Button disabled={!(dirty || conflict) || action.busy} onClick={reset}>Discard</Button>
        <Button ref={saveButton} variant="primary" busy={action.busy} disabled={!dirty || conflict || action.busy || !!capError || !!loadError} onClick={() => void save()}>Save changes</Button>
      </div>
    </div>
    <ErrorMessage error={readError} />
    <Feedback action={action} />
    {dialogs.dialog}
  </ResourceState>;
}

/** Guided add: an alias from the user's SSH config, a pacer name, then a live connect-and-check list. */
export function AddHost({ initialAliases }: { initialAliases?: string[] }) {
  const scoped = useScoped();
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
      {!passed && <Button size="sm" variant="primary" busy={add.busy || check.busy} disabled={!!problem || !state.connected} onClick={() => void connect()}>{added ? "Check again" : "Connect and check"}</Button>}{added && (check.error || job?.state === "failed") && <TextAction href={scoped(`#/settings/hosts/${encodeURIComponent(added)}`)}>Manage {added}</TextAction>}</div>
    {!state.connected && <p className="u3-muted">Reconnecting. Connect and check will be available when the service reconnects.</p>}
    {problem && ssh && !added && <p className="u3-muted">{problem}</p>}
    {job && <CheckList label={`Checks for ${added}`} items={checkItems(job)} />}
    {job?.error && <p role="alert">{job.error.message}{job.error.hint && ` · ${job.error.hint}`}</p>}
    {passed && <><p className="u3-muted" role="status">{added} is connected. Next, map the repositories it should work on and add its executors.</p>
      <div className="u3-actions"><ButtonLink variant="primary" href={scoped(`#/settings/hosts/${encodeURIComponent(added)}`)}>Map repositories</ButtonLink><ButtonLink href={scoped(`#/settings/add-executor?host=${encodeURIComponent(added)}`)}>Add an agent here</ButtonLink></div></>}
    <Feedback action={add} />
    <ErrorMessage error={check.error} />
    </>}
  </div></section>;
}

function RemoteHostList() {
  const scoped = useScoped();
  const { state } = useTaskContext(), hosts = state.snapshot?.hosts;
  if (!hosts?.length) return null;
  return <section aria-labelledby="remote-hosts" className="u3-section">
    <SectionHeading id="remote-hosts">Remote hosts</SectionHeading>
    <div className="u3-table-wrap"><table><thead><tr>{["Host", "Checks", "Parallel tasks", "Executors", "Actions"].map(v => <th key={v} scope="col" className={v === "Actions" ? "sr-only" : undefined}>{v}</th>)}</tr></thead>
      <tbody>{hosts.map(host => <tr key={host.alias}>
        <td data-label="Host"><strong>{host.alias}</strong><div><code>ssh {host.ssh}</code></div></td>
        <td data-label="Checks">{words(host.state)}</td>
        <td data-label="Parallel tasks">{host.running} of {host.maxTasks} running</td>
        <td data-label="Executors">{host.executors.length ? <div className="u3-chips">{host.executors.map(id => <span className="u3-chip" key={id} title={id}><AgentMark agent={id.split("#")[0]!} size={16} labelled={false} />{executorLabel(id)}</span>)}</div> : <span className="u3-muted">None yet</span>}</td>
        <td data-label="Actions"><TextAction href={scoped(`#/settings/hosts/${encodeURIComponent(host.alias)}`)}>Manage<span className="sr-only"> {host.alias}</span></TextAction></td>
      </tr>)}</tbody></table></div>
  </section>;
}
