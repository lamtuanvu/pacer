import { useEffect, useState } from "preact/hooks";
import type { AssistantSettings as Settings } from "../../../../src/assistant/types";
import { Alert } from "../../ds/Alert";
import { Button } from "../../ds/Button";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { Field, TextInput } from "../../ds/Controls";
import { useDialogs } from "../../ds/useDialogs";
import { LoadingState } from "../../ds/Patterns";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { Section, useResource } from "./shared";

interface Candidates { accounts: { account: string; models: { id: string; name: string }[]; runners: { id: string; model: string | null }[]; isPlanner: boolean }[]; reads: string[] }
interface Status { available: boolean; reason?: string; hint?: string; today: { turns: number; input: number; output: number } }

/** Settings › Assistant: which account answers, what it can read, limits, history. Off until an account is chosen. */
export function AssistantSettingsSection() {
  const { api } = useTaskContext(), dialogs = useDialogs();
  const settings = useResource<Settings>("assistant.settings.get"), candidates = useResource<Candidates>("assistant.candidates"), status = useResource<Status>("assistant.status");
  const [account, setAccount] = useState<string | null>(null), [runner, setRunner] = useState<string>(""), [turns, setTurns] = useState(""), [days, setDays] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!settings.data) return;
    setAccount(settings.data.account); setRunner(settings.data.runner ?? ""); setTurns(String(settings.data.limits.turnsPerDay)); setDays(String(settings.data.retention.days));
  }, [settings.data?.rev]);
  if (!settings.data || !candidates.data) return <Section id="assistant" title="Assistant"><LoadingState label="Loading assistant settings…" />{settings.error ? <ErrorMessage error={settings.error} /> : null}</Section>;
  const chosen = candidates.data.accounts.find(a => a.account === account);
  const runnerOptions = [{ value: "", label: "The account’s default model" }, ...(chosen?.runners ?? []).map(r => ({ value: r.id, label: r.model ? `${r.id} · ${r.model}` : r.id }))];
  const act = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(undefined); setSaved(null);
    try { await work(); setSaved(message); settings.reload(); status.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const save = () => act(() => api.call("assistant.settings.set", { account, runner: runner || null, expect_rev: settings.data!.rev, limits: { turnsPerDay: Number(turns) }, retention: { days: Number(days) } }), "Saved.");
  return <Section id="assistant" title="Assistant" detail="Ask questions about your tasks, dispatch and budgets from anywhere in the app. It is off until you choose an account.">
    <div className="pc-card pc-stack pc-stack--normal">
      <Field label="Account that answers" help="The assistant uses this account only. It never moves to another one, and its use is counted as assistant use, apart from your tasks.">
        <ChoicePicker value={account ?? ""} placeholder="Off — choose an account" options={[{ value: "", label: "Off" }, ...candidates.data.accounts.map(a => ({ value: a.account, label: a.isPlanner ? `${a.account} (planner)` : a.account }))]} onValueChange={value => { setAccount(value || null); setRunner(""); }} />
      </Field>
      {chosen?.isPlanner && <Alert tone="warning" title="This is your planner’s account">The assistant follows the planner’s pacing: it answers in relaxed and normal mode and pauses in strict and emergency mode.</Alert>}
      {chosen && <Field label="Model"><ChoicePicker value={runner} options={runnerOptions} onValueChange={setRunner} /></Field>}
      <Field label="Questions per day" help="Turns beyond this wait until midnight."><TextInput type="number" min="1" max="1000" value={turns} onInput={event => setTurns(event.currentTarget.value)} /></Field>
      <Field label="Keep history for (days)" help="Older conversations are deleted. At most 200 conversations are kept."><TextInput type="number" min="1" max="365" value={days} onInput={event => setDays(event.currentTarget.value)} /></Field>
      <div><Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button></div>
      {saved && <p role="status">{saved}</p>}
      <ErrorMessage error={error} />
    </div>
    <div className="pc-card pc-stack pc-stack--compact">
      <p><strong>What the assistant can read</strong></p>
      <ul>{candidates.data.reads.map(line => <li key={line}>{line}</li>)}</ul>
      <p>It cannot see task goals, output, diffs, files, keys or terminal screens. Secrets and your home folder path are removed before anything is sent. What it reads, and your questions, go to the account’s model{account ? ` (${account})` : ""}.</p>
      <p>It can only suggest actions. Nothing runs until you press the button on its card.</p>
    </div>
    <div className="pc-card pc-stack pc-stack--compact">
      <p><strong>History</strong></p>
      <p>{status.data ? `${status.data.today.turns} question${status.data.today.turns === 1 ? "" : "s"} today.` : "Loading…"} Conversations are stored on this machine in pacer’s home.</p>
      <div><Button disabled={busy} onClick={() => void (async () => { if (await dialogs.confirm("Delete every assistant conversation? Usage figures stay, without the text.", "Clear history", "Clear history")) await act(() => api.call("assistant.delete", {}), "History cleared."); })()}>Clear history</Button></div>
    </div>
    {dialogs.dialog}
  </Section>;
}
