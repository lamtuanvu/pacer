import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { Pill } from "../ds/Pill";
import type { SetupChecklist } from "../../../src/setup/checklist";
import type { Account, Model } from "../model/accounts";
import { agents, blankWizard, endpointParams, nextStep, previousStep, validateWizard, type Step } from "../model/wizard";
import { ErrorMessage, useAction, useDraft, useQuery, useTaskContext } from "./task-shared";
import { Signin } from "./Accounts";
export function AddExecutor() {
  const { api } = useTaskContext();
  const [draft, setDraft] = useDraft("pacer.add-executor", { ...blankWizard, key_source: /Mac/.test(navigator.platform) ? "keychain" : "file" });
  const [step, setStep] = useState<Step>(1), [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ state: string; detail?: string }>(), [created, setCreated] = useState(false);
  const [found, setFound] = useState<Model[]>([]), [discovery, setDiscovery] = useState("");
  const keyInput = useRef<HTMLInputElement>(null), pending = useRef(false);
  const action = useAction(), accounts = useQuery<Account[]>("account.list", {}), setup = useQuery<SetupChecklist>("setup.check", {});
  const field = (key: keyof typeof draft, value: string) => { setDraft(d => ({ ...d, [key]: value })); setError(undefined); };
  const endpoint = draft.agent === "opencode", native = ["claude-code", "codex"].includes(draft.agent);
  const account = accounts.data?.find(a => a.name === draft.account);
  const models = (() => { try { return JSON.parse(draft.models) as Model[]; } catch { return []; } })();
  const updateModel = (index: number, patch: Partial<Model>) => field("models", JSON.stringify(models.map((m, i) => i === index ? { ...m, ...patch } : m)));
  useEffect(() => {
    if (step !== 2 || !account || account.signedIn === true || !account.signin_command) return;
    const timer = setInterval(accounts.reload, 3000); return () => clearInterval(timer);
  }, [step, account]);
  async function discover() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      const url = new URL(draft.base_url); if (!["http:", "https:"].includes(url.protocol)) throw Error("Enter an HTTP or HTTPS base URL.");
      const response = await api.call<{ models: Model[]; listed: boolean; error?: string }>("account.models", { base_url: draft.base_url, ...(keyInput.current?.value ? { key: keyInput.current.value } : {}) });
      setFound(response.models);
      setDiscovery(response.error ?? (response.listed ? `${response.models.length} models found. Choose models below.` : "This endpoint doesn't list models. Enter model ids below."));
    } catch (error) { setError(error); } finally { pending.current = false; setBusy(false); }
  }
  async function finish() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try {
      let response: { state: string; detail?: string };
      if (endpoint) {
        if (created || draft.account) response = await api.call("account.test", { name: draft.account || draft.name });
        else {
          const params = endpointParams(draft, keyInput.current?.value ?? "");
          if (keyInput.current) keyInput.current.value = "";
          const added = await api.call<{ state: string | { state: string; detail?: string } }>("account.add", params);
          setCreated(true);
          response = typeof added.state === "string" ? { state: added.state } : added.state;
        }
      } else {
        await api.call("runner.add", { agent: draft.agent, ...(draft.account ? { account: draft.account } : {}) });
        response = { state: "not_tested" };
      }
      setResult(response);
      if (endpoint && !["ready", "Ready"].includes(response.state)) setError(new Error(response.detail ?? "The test did not pass. Try again."));
    } catch (error) { setError(error); } finally { pending.current = false; setBusy(false); }
  }
  const complete = result && (!endpoint || ["ready", "Ready"].includes(result.state));
  return <section className="screen"><h1>Add an executor</h1><ol className="wizard-steps" aria-label="Progress">{["Agent", "Account", "Connection", "Test"].map((name, i) => <li aria-current={step === i + 1 ? "step" : undefined} key={name}>{i + 1} · {name}</li>)}</ol>
    <Card><form onSubmit={e => { e.preventDefault(); const validation = validateWizard(step, draft); if (validation) { setError(new Error(validation)); return; } setError(undefined); setStep(step === 2 && endpoint && draft.account ? 4 : nextStep(step, draft.agent)); }}>
      {step === 1 && <><h2>Which agent should do the work?</h2><div className="executor-choices">{agents.map(agent => {
        const item = setup.data?.items.find(i => i.id === `agent:${agent.id}`);
        return <Button key={agent.id} aria-pressed={draft.agent === agent.id} onClick={() => { field("agent", agent.id); field("account", ""); }}><strong>{agent.name}</strong><span className="muted">{item ? item.status === "done" ? "Installed" : "Not installed" : "Installation unknown"}</span></Button>;
      })}</div><ErrorMessage error={setup.error} /></>}
      {step === 2 && <><h2>Which account pays for it?</h2><p className="muted">An account is one budget. Several executors can share it; pacer paces them together.</p>
        {endpoint ? <><label className="field">Existing endpoint<select value={draft.account} onChange={e => field("account", e.currentTarget.value)}><option value="">Create a new endpoint</option>{accounts.data?.filter(a => a.kind === "endpoint").map(a => <option key={a.name}>{a.name}</option>)}</select></label><label className="field">New account name<input required={!draft.account} pattern="[a-z0-9][a-z0-9-]*" value={draft.name} onInput={e => field("name", e.currentTarget.value)} /></label></> : <>
          {native ? <><label className="field">Existing account<select value={draft.account} onChange={e => field("account", e.currentTarget.value)}><option value="">Choose account</option>{accounts.data?.filter(a => a.kind === (draft.agent === "codex" ? "codex" : "claude")).map(a => <option key={a.name}>{a.name}</option>)}</select></label>
          <label className="field">New account name<input value={draft.name} pattern="[a-z0-9][a-z0-9-]*" onInput={e => field("name", e.currentTarget.value)} /></label><Button disabled={action.busy || !draft.name} onClick={() => { void action.run<{ account: Account }>("account.add", { kind: draft.agent === "codex" ? "codex" : "claude", name: draft.name }, r => { field("account", r.account.name); accounts.reload(); }); }}>Create account</Button></> : <p>This agent uses its own signed-in account.</p>}
          {account?.signin_command && account.signedIn !== true && <><Pill tone="warn">Sign-in not confirmed</Pill><Signin command={account.signin_command} /><p className="muted">Checking sign-in every 3 seconds…</p></>}
          {account?.signedIn === true && <Pill tone="good">Signed in</Pill>}
        </>}<ErrorMessage error={accounts.error ?? action.error} /></>}
      <div hidden={step !== 3}>
        <h2>Connect to the endpoint</h2><label className="field">Base URL<input disabled={step !== 3} type="url" value={draft.base_url} onInput={e => field("base_url", e.currentTarget.value)} /></label>
        <label className="field">Key source<select value={draft.key_source} onChange={e => { field("key_source", e.currentTarget.value); if (keyInput.current) keyInput.current.value = ""; }}><option value="keychain">Keychain (macOS)</option><option value="file">File</option><option value="env">Environment variable</option><option value="none">None</option></select></label>
        <label className="field" hidden={!["keychain", "file"].includes(draft.key_source)}>API key<input ref={keyInput} type="password" autoComplete="off" /></label>
        {draft.key_source === "env" && <label className="field">Environment variable<input value={draft.env_var} onInput={e => field("env_var", e.currentTarget.value)} /></label>}
        <p className="muted">The key goes to its store and is never saved in this form.</p><Button disabled={busy} onClick={() => { void discover(); }}>{busy ? "Finding models…" : "Find models"}</Button><p aria-live="polite">{discovery}</p>
        {found.map(m => <label className="model-choice" key={m.id}><input type="checkbox" checked={models.some(v => v.id === m.id)} onChange={e => field("models", JSON.stringify(e.currentTarget.checked ? [...models, { ...m, tools: true }] : models.filter(v => v.id !== m.id)))} />{m.name ?? m.id}</label>)}
        <Button onClick={() => field("models", JSON.stringify([...models, { id: "", tools: true }]))}>Enter a model manually</Button>
        {models.map((m, i) => <fieldset key={i}><legend>Model {i + 1}</legend><label className="field">Model id<input value={m.id} onInput={e => updateModel(i, { id: e.currentTarget.value })} /></label><div className="form-row"><label className="field">Context limit<input type="number" min="1" value={m.context ?? ""} onInput={e => updateModel(i, { context: Number(e.currentTarget.value) })} /></label><label className="field">Output limit<input type="number" min="1" value={m.output ?? ""} onInput={e => updateModel(i, { output: Number(e.currentTarget.value) })} /></label></div><label><input type="checkbox" checked={m.tools !== false} onChange={e => updateModel(i, { tools: e.currentTarget.checked })} /> Supports tools</label><Button onClick={() => field("models", JSON.stringify(models.filter((_, n) => n !== i)))}>Remove model</Button></fieldset>)}
        <label className="field">Usage<select value={draft.usage} onChange={e => field("usage", e.currentTarget.value)}><option value="unmetered">Unmetered</option><option value="metered">Metered</option><option value="quota">Quota</option></select></label>
      </div>
      {step === 4 && <><h2>{endpoint ? "Test it with a tiny task" : "Add the executor"}</h2><p>{endpoint ? "pacer edits one file in a scratch folder and checks the result. The test uses a few hundred tokens and can take up to 2 minutes." : "This executor will be marked Not tested. Delegate a task when you are ready."}</p>
        {complete ? <><Pill tone={endpoint ? "good" : "neutral"}>{endpoint ? "Ready" : "Not tested"}</Pill><a className="pc-btn pc-btn--primary pc-btn--md" href="#/executors">Done</a></> : <Button variant="primary" disabled={busy} onClick={() => { void finish(); }}>{busy ? "Running…" : error ? "Try again" : endpoint ? "Run a test task" : "Add executor"}</Button>}
        {busy && <p aria-live="polite">Testing the connection and executor…</p>}
      </>}
      <div aria-live="polite"><ErrorMessage error={error} /></div><div className="row">{step > 1 && !complete && <Button disabled={busy} onClick={() => { setError(undefined); setStep(step === 4 && draft.account ? 2 : previousStep(step, draft.agent)); }}>Back</Button>}<span className="grow" />{step < 4 && <Button type="submit" variant="primary" disabled={busy || action.busy}>Continue</Button>}</div>
    </form></Card>
  </section>;
}
