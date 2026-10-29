import { ChoiceCard, FilterChip, TextRow, RadioChoices } from "../../ds/Patterns";
import { TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { accountNeedsSignIn, accountStatus } from "../../../../src/view-model/words";
import { SectionHeading } from "../../ds/SectionHeading";
import { SettingRow } from "../../ds/SettingRow";
import { CheckList, Stepper } from "../../ds/Stepper";
import { useState, useEffect, useRef } from "preact/hooks";
import type { AgentDetection } from "../../../../src/install/detection";
import type { Job } from "../../../../src/api/read-model/types";
import { Pill } from "../../ds/Pill";
import { AgentMark } from "../../ds/AgentMark";
import { Button, ButtonLink, TextAction } from "../../ds/Button";
import type { Account } from "../../model/accounts";
import { AGENT_KINDS, REMOTE_AGENTS, accountRequired, agentStepProblem, agents, blankAgentDraft, furthestAgentStep, type AgentDraft } from "../../model/wizard";
import { useDraft, useTaskContext } from "../task-shared";
import { OpencodeSetup } from "./OpencodeSetup";
import { useDialogs } from "../../ds/useDialogs";
import { Feedback, Field, latestJob, ResourceState, SettingsBoard, useOperation, useResource, useScoped, words } from "./shared";
export const executorId = ({ agent, account, host }: { agent: string; account: string; host: string }) =>
  `${agent}${account ? `#${account}` : ""}${host && host !== "local" ? `@${host}` : ""}`;
export const executorReady = (job: Job | undefined, target?: string) =>
  job?.kind === "runner.check" && job.state === "passed" && (!target || job.target === target);
const TITLES = ["Agent", "Account", "Where it runs", "Model and test"];
/** Add an agent in four gated steps; it is Ready only after its test task passes. */
export function AddExecutor({ host: prefillHost = "", initialDraft = {}, initialAccounts, initialDetection, initialUrlForm = false }: {
  host?: string; initialDraft?: Partial<AgentDraft>; initialAccounts?: Account[]; initialDetection?: AgentDetection[]; initialUrlForm?: boolean;
}) {
  const scoped = useScoped();
  const { state, api } = useTaskContext(),
    [draft, setDraft, clearDraft] = useDraft("pacer.settings.add-executor", { ...blankAgentDraft, host: prefillHost, ...initialDraft });
  const accounts = useResource<Account[]>("account.list", {}, initialAccounts),
    detected = useResource<AgentDetection[]>("agent.detect", {}, initialDetection);
  const action = useOperation(), [resumed, setResumed] = useState<Job>(), [urlForm, setUrlForm] = useState(initialUrlForm), [resumeError, setResumeError] = useState("");
  const patch = (patch: Partial<AgentDraft>) => setDraft(d => ({ ...d, ...patch }));
  const job = action.job ?? (draft.jobId ? latestJob(state.jobs[draft.jobId], resumed) : undefined),
    ready = !!draft.createdId && executorReady(job, draft.createdId), locked = !!draft.createdId;
  const facts = { installed: detected.data?.find(a => a.agent === draft.agent)?.found ?? null, hosts: state.snapshot?.hosts?.map(h => h.alias) ?? [] };
  const furthest = furthestAgentStep(draft, facts), step = Math.min(Number(draft.step) || 1, furthest), problem = agentStepProblem(step, draft, facts);
  const compatible = accounts.data?.filter(a => draft.agent === "opencode" ? a.kind === "endpoint" : draft.agent === "claude-code" ? a.kind === "claude" : a.kind === draft.agent) ?? [];
  const name = agents.find(a => a.id === draft.agent)?.name ?? draft.agent, kinds = draft.kinds ? draft.kinds.split(",") : [];
  // On the OpenCode provider picker, adding the provider creates the account and its executor, so it is the step's one primary action.
  const picker = step === 2 && draft.agent === "opencode" && !urlForm && !draft.account && !locked;
  useResumeJob(draft.jobId, action.job ?? state.jobs[draft.jobId], api.call, setResumed, setResumeError);
  // A step change is announced and moves focus to the new step's heading, so keyboard and screen reader users land in it.
  const shown = useRef(step), dialogs = useDialogs();
  useEffect(() => { if (shown.current !== step) { shown.current = step; document.getElementById("agent-step-heading")?.focus(); } }, [step]);
  // Arriving from a host's "Add an agent here" link selects that host even when an older draft exists.
  useEffect(() => { if (prefillHost && !draft.createdId && draft.host !== prefillHost) patch({ host: prefillHost }); }, [prefillHost]);
  const startOver = () => { action.clear(); setResumed(undefined); setResumeError(""); setUrlForm(false); setDraft({ ...blankAgentDraft }); };
  async function removeAgent() {
    if (!(await dialogs.confirm(`Remove ${draft.createdId}? It was added but has not passed its test task.`, "Remove agent", "Remove"))) return;
    if (await action.run("runner.remove", { id: draft.createdId })) { action.clear(); setResumed(undefined); clearDraft(); setDraft({ ...blankAgentDraft }); }
  }
  async function finish() {
    if (draft.createdId) { const r = await action.run("runner.check", { id: draft.createdId }); if (r?.jobId) patch({ jobId: r.jobId }); return; }
    const r = await action.run("runner.add", { agent: draft.agent, ...(draft.account ? { account: draft.account } : {}), ...(draft.host ? { host: draft.host } : {}),
      ...(draft.model ? { model: draft.model } : {}), ...(kinds.length ? { kinds } : {}), max_tasks: Number(draft.maxTasks), test: true });
    if (r) patch({ createdId: (r.data as { id: string }).id, jobId: r.jobId ?? "" });
  }
  const accountModels = accounts.data?.find(a => a.name === draft.account)?.connection?.models ?? [];
  const modelOptions = [{ value: "", label: "Agent default" }, ...accountModels.map(m => ({ value: m.id, label: m.name ?? m.id }))];
  if (draft.model && !modelOptions.some(m => m.value === draft.model)) modelOptions.push({ value: draft.model, label: draft.model });
  const [detectionStatus, setDetectionStatus] = useState('');
  const rechecking = useRef<Set<string>>(), checkButton = useRef<HTMLButtonElement>(null);
  const checkAgain = () => {
    rechecking.current = new Set(detected.data?.filter(a => a.found).map(a => a.agent));
    setDetectionStatus('');
    detected.reload();
  };
  useEffect(() => {
    if (!rechecking.current || detected.loading) return;
    const newlyFound = !detected.error && agents.find(agent => !rechecking.current!.has(agent.id) && detected.data?.some(a => a.agent === agent.id && a.found));
    rechecking.current = undefined;
    if (newlyFound) {
      document.getElementById(`agent-choice-${newlyFound.id}`)?.focus();
      setDetectionStatus(`${newlyFound.name} found`);
    } else checkButton.current?.focus();
  }, [detected.loading, detected.data, detected.error]);
  const installGuidance = !!detected.data?.some(a => !a.found && a.install_hint);
  const values = [name, draft.account || (accountRequired(draft.agent) ? "" : "Its own sign-in"), `${facts.hosts.includes(draft.host) ? draft.host : "This machine"} · ${draft.maxTasks} parallel`, ready ? "Ready" : job ? "Test task run" : "Not tested yet"];
  return (
    <div className="u3-add-agent">
      <nav className="u3-breadcrumb" aria-label="Breadcrumb"><TextAction href={scoped("#/settings/executors")}>Agents</TextAction><span aria-hidden="true">/</span><span>Add an agent</span></nav>
      <SettingsBoard id="add-agent" title="Add an agent" caption="pacer finds the agent CLIs on this machine. Four short steps, and the agent is checked with a real test task before it gets work.">
      <div className="u3-wizard">
      {dialogs.dialog}
      <div className="sr-only" role="status" aria-live="polite">{detectionStatus || `Step ${step} of 4: ${TITLES[step - 1]}`}</div>
      <Stepper label="Add agent steps" onSelect={id => patch({ step: id })} steps={TITLES.map((title, i) => ({
        id: String(i + 1), title, reachable: i + 1 <= furthest && (!locked || i === 3),
        state: i === 3 && ready ? "done" : i + 1 === step ? "current" : i + 1 < furthest ? "done" : "todo",
        detail: i + 1 <= furthest ? values[i] || "Not set" : "Not set",
      }))} />
      <section className="u3-wizard-panel" aria-labelledby="agent-step-heading">
        {step === 1 && <>
          <div className="u3-step-heading"><SectionHeading variant="headline" id="agent-step-heading" tabIndex={-1}>Which agent?</SectionHeading><p className="u3-muted">{installGuidance ? "Found on this Mac. Agents that aren’t installed show how to get them." : "pacer looks for each agent’s CLI on this Mac."}</p></div>
          <div className="u3-agent-choices"><ResourceState resource={detected}>{agents.map(agent => {
            const found = detected.data?.find(a => a.agent === agent.id);
            return <ChoiceCard layout="agent" key={agent.id} id={`agent-choice-${agent.id}`} aria-pressed={draft.agent === agent.id}
              onClick={() => patch({ agent: agent.id, account: "", host: REMOTE_AGENTS.includes(agent.id) ? draft.host : "" })}>
              <span className="u3-agent-choice-title"><AgentMark agent={agent.id} size={28} /><strong>{agent.name}</strong>{draft.agent === agent.id && <span className="u3-selected-check" aria-hidden="true">✓</span>}</span><span className="u3-muted">{agent.tagline}</span>
                {found && <Pill tone={found.found ? "good" : "neutral"}>{found.found ? `Found${found.version ? ` ${found.version}` : ""}` : "Not found"}</Pill>}
                {found && !found.found && found.install_hint && <span className="u3-muted">Install: <code>{found.install_hint}</code></span>}
            </ChoiceCard>;
          })}</ResourceState></div>
          {(facts.installed === false || !!rechecking.current) && <div className="u3-actions"><span>{problem}</span><Button ref={checkButton} busy={detected.loading} onClick={checkAgain}>Check again</Button></div>}
        </>}
        {step === 2 && <>
          <div className="u3-step-heading"><SectionHeading variant="headline" id="agent-step-heading" tabIndex={-1}>Which account pays for it?</SectionHeading><p className="u3-muted">pacer uses the agent’s own sign-in and never copies it.</p></div>
          {!accountRequired(draft.agent) ? <RadioChoices layout="options" name="agent-own-account" label="Account" value="own" onChange={() => {}} options={[{ value: "own", label: <><strong>{name}’s own signed-in account</strong><span className="u3-muted">Uses the agent’s own sign-in. pacer never copies it.</span></> }]} /> : <>
            <p className="u3-muted">Two executors can share an account; they share its quota.</p>
            <ResourceState resource={accounts} empty="No accounts yet. Add one below.">
              {compatible.length ? <RadioChoices layout="options" name="agent-account" label="Account" value={draft.account} onChange={account => patch({ account })}
                options={compatible.map(account => ({ value: account.name, label: <><strong>{account.name}</strong><span className="u3-muted">{account.source ?? account.kind} · {accountStatus(account).label}</span></> }))} /> : <p>No accounts for this agent yet.</p>}
            </ResourceState>
            {draft.agent === "opencode" && !urlForm
              // The OpenCode account and its executor are created together; step 4 then runs the test task as the check.
              ? <OpencodeSetup onUseUrl={() => setUrlForm(true)} onCreated={account => { patch({ account, createdId: `opencode#${account}`, step: "4" }); accounts.reload(); }} />
              : <>{draft.agent === "opencode" && <p><Button variant="quiet" size="sm" onClick={() => setUrlForm(false)}>Back to providers</Button></p>}
                <WizardAccount agent={draft.agent} onCreated={account => { patch({ account }); accounts.reload(); }} /></>}
            {draft.account && accountNeedsSignIn(accounts.data?.find(a => a.name === draft.account) ?? { kind: "endpoint" }) &&
              <Button disabled={action.busy} onClick={() => void action.run("account.signin", { name: draft.account })}>Sign in to {draft.account}</Button>}
          </>}
        </>}
        {step === 3 && <>
          <div className="u3-step-heading"><SectionHeading variant="headline" id="agent-step-heading" tabIndex={-1}>Where does it run?</SectionHeading><p className="u3-muted">Tasks run in their own worktree on that machine.</p></div>
          {REMOTE_AGENTS.includes(draft.agent)
            ? <RadioChoices layout="options" name="agent-location" label="Runs on" value={draft.host ? "remote" : "local"}
                options={[{ value: "local", label: <><strong>This Mac</strong><span className="u3-muted">{state.snapshot?.machine ? `${state.snapshot.machine.max} parallel tasks shared by every executor here` : "Runs on this machine"}</span></> },
                  ...(facts.hosts.length ? [{ value: "remote", label: <><strong>A remote host</strong><span className="u3-muted">Choose a configured host below</span></> }] : [])]}
                onChange={v => patch({ host: v === "local" ? "" : facts.hosts[0] ?? "" })} />
            : <p>{name} runs on this machine. Only Codex and Claude Code can run on a remote host.</p>}
          {REMOTE_AGENTS.includes(draft.agent) && !facts.hosts.length && <p className="u3-muted">No remote hosts yet. <TextAction href={scoped("#/settings/machine")}>Add one in Machines</TextAction></p>}
          {draft.host && (facts.hosts.length
            ? <SettingRow label="Remote host"><ChoicePicker value={draft.host} placeholder="Choose a host" options={state.snapshot!.hosts!.map(h => ({ value: h.alias, label: `${h.alias} · ${words(h.state)}` }))} onValueChange={host => patch({ host })} /></SettingRow>
            : <p>No remote hosts yet. <TextAction href={scoped("#/settings/machine")}>Add one in Machines</TextAction></p>)}
          <SettingRow label="Parallel tasks" description="1–16; the machine’s own limit still applies.">
            <TextInput className="u3-parallel-input" type="number" min="1" max="16" step="1" required value={draft.maxTasks} onInput={e => patch({ maxTasks: e.currentTarget.value })} />
          </SettingRow>
        </>}
        {step === 4 && <>
          <div className="u3-step-heading"><SectionHeading variant="headline" id="agent-step-heading" tabIndex={-1}>Model, then a test task</SectionHeading><p className="u3-muted">The agent is Ready only after a real task passes.</p></div>
          <SettingRow label="Model"><ChoicePicker className="u3-model-picker" disabled={locked} value={draft.model} options={modelOptions} onValueChange={model => patch({ model })} /></SettingRow>
          <SettingRow label="Good at" description={kinds.length ? "Added to these task kinds’ routing rules." : "Added to the rule for everything else."}>
            <div className="u3-actions" role="group" aria-label="Good at">{AGENT_KINDS.map(([kind, label]) => <FilterChip key={kind} disabled={locked} selected={kinds.includes(kind)}
              onClick={() => patch({ kinds: (kinds.includes(kind) ? kinds.filter(k => k !== kind) : [...kinds, kind]).join(",") })}>{label}</FilterChip>)}</div>
          </SettingRow>
          <TextRow label="Executor id" value={<code>{draft.createdId || executorId(draft)}</code>} />
          <div className="u3-test-task"><div className="u3-heading"><strong>Test task</strong><Pill tone={ready ? "good" : job?.state === "failed" ? "bad" : job ? "info" : "neutral"}>{ready ? "Passed" : job?.state === "failed" ? "Failed" : job ? "Running" : "Not tested yet"}</Pill></div>
          {job ? <CheckList unboxed label="Test task" items={job.steps.map(s => ({ id: s.name, label: s.name, state: s.state, note: s.detail }))} /> : <p className="u3-muted">Creates a scratch worktree, asks the agent for a small change, then checks the result.</p>}
          {job?.error && <p role="alert">{job.error.message}{job.error.hint && ` · ${job.error.hint}`}</p>}
          {ready && <p role="status"><strong>{draft.createdId} is ready.</strong> Test task passed.</p>}
          {!ready && <div className="u3-actions"><Button variant="primary" busy={action.busy || job?.state === "running"} onClick={() => void finish()}>{job?.state === "running" ? "Running test task…" : locked ? job ? "Run test task again" : "Run test task" : "Add agent and run test task"}</Button></div>}
          </div>
        </>}
        {resumeError && <p role="status">{resumeError}</p>}
        <Feedback action={action} />
        <div className="u3-footer">
          <span className="u3-muted">{problem ?? `Step ${step} of 4 · Your draft is kept if you leave${locked ? "; agent added; test before Ready" : ""}`}</span>
          {ready ? <>
            <Button onClick={() => { action.clear(); setResumed(undefined); setResumeError(""); setUrlForm(false); setDraft({ ...blankAgentDraft }); }}>Add another agent</Button>
            <ButtonLink variant="primary" href={scoped("#/settings/executors")} onClick={clearDraft}>Open agents</ButtonLink>
          </> : <>
            {locked ? <><Button disabled={action.busy} onClick={() => void removeAgent()}>Remove this agent</Button><Button variant="quiet" disabled={action.busy} onClick={startOver}>Start over</Button></> : <TextAction href={scoped("#/settings/executors")}>Cancel</TextAction>}
            {step > 1 && !locked && <Button disabled={action.busy} onClick={() => patch({ step: String(step - 1) })}>Back</Button>}
            {step < 4 ? !picker && <Button variant="primary" disabled={action.busy || !!problem} onClick={() => patch({ step: String(step + 1) })}>Continue</Button>
              : null}
          </>}
        </div>
      </section>
      </div>
      </SettingsBoard>
    </div>
  );
}
import type { BrowserApi } from "../../data/api";

function useResumeJob(
  id: string,
  known: Job | undefined,
  call: BrowserApi["call"],
  setJob: (job: Job) => void,
  setError: (message: string) => void,
) {
  useEffect(() => {
    if (!id || (known && known.state !== "running")) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const job = await call<Job>("job.get", { id });
        if (active) {
          setJob(job);
          setError("");
          if (job.state !== "running") return;
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
      if (active) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, known?.state, call]);
}
function WizardAccount({
  agent,
  onCreated,
}: {
  agent: string;
  onCreated: (name: string) => void;
}) {
  const action = useOperation(),
    [draft, setDraft, clearDraft] = useDraft(
      `pacer.settings.new-account.${agent}`,
      {
        name: "",
        url: "",
        model: "",
        env: "",
        context: "128000",
        output: "8192",
        usage: "unmetered",
        weekly: "",
      },
    );
  const { name, url, model, env, context, output, usage, weekly } = draft;
  const set = (key: keyof typeof draft, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const endpoint = agent === "opencode",
    native = ["codex", "claude-code"].includes(agent);
  return (
    <div className="pc-card">
      <SectionHeading as="h3">New account</SectionHeading>
      {native || endpoint ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(
              "account.add",
              endpoint
                ? {
                    kind: "endpoint",
                    name,
                    base_url: url,
                    key_source: env ? "env" : "none",
                    ...(env ? { env_var: env } : {}),
                    models: [
                      {
                        id: model,
                        context: Number(context),
                        output: Number(output),
                        tools: true,
                      },
                    ],
                    usage,
                    ...(usage === "quota" ? { quota_source: "arkcli" } : {}),
                    ...(usage === "metered" && weekly
                      ? { weekly_tokens: Number(weekly) }
                      : {}),
                    test: true,
                  }
                : { kind: agent === "codex" ? "codex" : "claude", name },
              () => {
                clearDraft();
                onCreated(name);
              },
            );
          }}
        >
          <Field label="Account name">
            <TextInput
              required
              value={name}
              pattern="[a-z0-9][a-z0-9-]*"
              onInput={(e) => set("name", e.currentTarget.value)}
            />
          </Field>
          {endpoint && (
            <>
              <Field label="Base URL">
                <TextInput
                  type="url"
                  required
                  value={url}
                  onInput={(e) => set("url", e.currentTarget.value)}
                />
              </Field>
              <Field
                label="API key environment variable"
                help="Set this variable in the service environment. No secret is stored in the draft."
              >
                <TextInput
                  value={env}
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  onInput={(e) => set("env", e.currentTarget.value)}
                />
              </Field>
              <Field label="Model id">
                <TextInput
                  required
                  value={model}
                  onInput={(e) => set("model", e.currentTarget.value)}
                />
              </Field>
              <div className="u3-settings-grid">
                <Field label="Context limit">
                  <TextInput
                    type="number"
                    min="1"
                    required
                    value={context}
                    onInput={(e) => set("context", e.currentTarget.value)}
                  />
                </Field>
                <Field label="Output limit">
                  <TextInput
                    type="number"
                    min="1"
                    required
                    value={output}
                    onInput={(e) => set("output", e.currentTarget.value)}
                  />
                </Field>
              </div>
              <Field label="Usage">
                <ChoicePicker
                  value={usage}
                  options={[{ value: "quota", label: "Quota — a plan with limits" }, { value: "metered", label: "Metered — pay per token" }, { value: "unmetered", label: "Unmetered — free or local" }]}
                  onValueChange={(value) => set("usage", value)}
                />
              </Field>
              {usage === "quota" && (
                <p className="u3-muted">
                  Quota source: arkcli (reads it for you)
                </p>
              )}
              {usage === "metered" && (
                <Field label="Weekly token budget (optional)">
                  <TextInput
                    type="number"
                    min="1"
                    value={weekly}
                    onInput={(e) => set("weekly", e.currentTarget.value)}
                  />
                </Field>
              )}
            </>
          )}
          <Button type="submit" disabled={action.busy}>
            Create account
          </Button>
        </form>
      ) : (
        <p>This agent uses its own signed-in account.</p>
      )}
      {native && (
        <Button
          disabled={action.busy}
          onClick={() =>
            void action.run("account.signin", {
              interactive: "account-add-orca",
            })
          }
        >
          Link from Orca
        </Button>
      )}
      <Feedback action={action} />
    </div>
  );
}
