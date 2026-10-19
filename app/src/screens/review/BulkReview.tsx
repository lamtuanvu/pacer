import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { AttentionItem } from "../../../../src/api/read-model/types";
import type { TaskDetail } from "../../../../src/core/task-detail";
import type { ClientSnapshot } from "../../../../src/view-model/snapshot";
import { reviewQueue } from "../../../../src/view-model/selectors";
import type { ActionRunner } from "../../data/actions";
import { Button } from "../../ds/Button";
import { Dialog } from "../task-shared";
import { verdictParams } from "./model";

export function scopedReviewQueue(snapshot: ClientSnapshot, repo: string | null): AttentionItem[] {
  return reviewQueue(snapshot).filter(item => item.taskId && !(item.snoozedUntil && item.snoozedUntil > snapshot.at) && (!repo || item.repo?.key === repo));
}
export function selectedReviews(items: AttentionItem[], selected: ReadonlySet<string>): AttentionItem[] {
  return items.filter(item => item.taskId && selected.has(item.taskId));
}
interface BulkRequest {
  items: AttentionItem[]; passingOnly: boolean; verdict: "accept" | "reject"; runner: ActionRunner;
  confirm: (message: string) => boolean | Promise<boolean>; prompt: (message: string) => string | null | Promise<string | null>;
}
/** Freeze the checked evidence at confirmation and submit each existing verdict op with its revision. */
export async function runBulkReview({ items, passingOnly, verdict, runner, confirm, prompt }: BulkRequest): Promise<string> {
  const tasks: TaskDetail[] = [], messages: string[] = [];
  const seen = new Set<string>();
  const unique = items.filter(item => {
    if (!item.taskId || seen.has(item.taskId)) return false;
    seen.add(item.taskId);
    return true;
  });
  // Read concurrently, then collect in queue order so the confirmation stays stable.
  const evidence = await Promise.all(unique.map(async item => {
    const key = `bulk-read:${item.taskId}`;
    const result = await runner.run(key, { label: "Read review evidence", op: "task.get", params: { id: item.taskId } });
    return { item, result, task: runner.result(key) as TaskDetail };
  }));
  for (const { item, result, task } of evidence) {
    if (result.status !== "done") {
      messages.push(`${item.title}: ${result.status === "error" || result.status === "handled" ? result.message : "Could not load evidence"}`);
      continue;
    }
    if (task.review || task.resolved || task.dismissed || task.retriedBy || !["done", "partial"].includes(task.state)) {
      messages.push(`${item.title}: no longer waiting for review`);
      continue;
    }
    if (!passingOnly || task.acceptance?.state === "passed") tasks.push(task);
  }
  if (!tasks.length) return ["No eligible tasks.", ...messages].join("\n");
  const note = verdict === "reject" ? await prompt("Rejection note for all selected tasks:") : undefined;
  if (verdict === "reject" && !note?.trim()) return "Cancelled. Rejection requires a note.";
  const label = verdict === "accept" ? "Accept" : "Reject";
  const list = tasks.map(task => `• ${task.title ?? task.goal} (${task.id}) · ${task.repo.label}`).join("\n");
  if (!await confirm(`${label} ${tasks.length} task(s)?\n\n${list}\n\n${note ? `Note: ${note}\n\n` : ""}This records verdicts only. You merge branches.${messages.length ? `\n\nSkipped:\n${messages.join("\n")}` : ""}`)) return "Cancelled. No verdicts recorded.";
  let done = 0;
  for (const task of tasks) {
    const result = await runner.run(`review:${task.id}`, {
      label: "Record verdict", op: "task.review", params: verdictParams(task, { verdict, ...(note ? { note } : {}) }),
    });
    if (result.status === "done") done++;
    else messages.push(`${task.title ?? task.id}: ${result.status === "error" || result.status === "handled" ? result.message : "Could not record verdict"}`);
  }
  return [`${label === "Accept" ? "Accepted" : "Rejected"} ${done} of ${tasks.length} task(s).`, ...messages].join("\n");
}

interface Selection { ids: ReadonlySet<string>; selected: ReadonlySet<string>; busy: boolean; toggle: (id: string) => void }
const BulkSelection = createContext<Selection | null>(null);
export function ReviewCheckbox({ item }: { item: AttentionItem }) {
  const selection = useContext(BulkSelection);
  if (!item.taskId || !selection?.ids.has(item.taskId)) return null;
  return <input className="pc-checkbox__input" type="checkbox" aria-label={`Select ${item.title}`} checked={selection.selected.has(item.taskId)} disabled={selection.busy}
    onChange={() => selection.toggle(item.taskId!)} />;
}
export function BulkReview({ snapshot, repo, runner, children }: { snapshot: ClientSnapshot; repo: string | null; runner: ActionRunner; children: ComponentChildren }) {
  const items = scopedReviewQueue(snapshot, repo);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const inFlight = useRef(false);
  const [dialog, setDialog] = useState<{ message: string; note: boolean } | null>(null);
  const [note, setNote] = useState("");
  const reply = useRef<((value: string | null) => void) | null>(null);
  const ask = (message: string, note: boolean) => new Promise<string | null>(resolve => {
    reply.current = resolve; setNote(""); setDialog({ message, note });
  });
  const answer = (value: string | null) => { reply.current?.(value); reply.current = null; setDialog(null); };
  useEffect(() => () => { reply.current?.(null); }, []);
  const ids = new Set(items.map(item => item.taskId!));
  const selected = new Set(selectedReviews(items, selection).map(item => item.taskId!));
  const run = async (verdict: "accept" | "reject", passingOnly = false) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage("");
    try {
      setMessage(await runBulkReview({ items: passingOnly ? items : selectedReviews(items, selected), passingOnly, verdict, runner,
        confirm: async text => (await ask(text, false)) !== null, prompt: text => ask(text, true) }));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <BulkSelection.Provider value={{ ids, selected, busy, toggle: id => setSelection(previous => {
    const next = new Set(selectedReviews(items, previous).map(item => item.taskId!));
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }) }}>
    {items.length > 0 && <div className="pc-bulk-review" role="group" aria-label="Bulk review">
      <div className="row-actions">
        <Button size="sm" disabled={busy} onClick={() => { void run("accept", true); }}>Accept all with passing checks</Button>
        <label className="pc-checkbox"><input className="pc-checkbox__input" type="checkbox" aria-label="Select all review tasks" disabled={busy} checked={selected.size === ids.size}
          onChange={() => setSelection(selected.size === ids.size ? new Set() : ids)} /> Select all</label>
        <span>{selected.size} selected</span>
        <Button size="sm" disabled={busy || !selected.size} onClick={() => { void run("accept"); }}>Accept selected</Button>
        <Button size="sm" disabled={busy || !selected.size} onClick={() => { void run("reject"); }}>Reject selected</Button>
      </div>
      {busy && <p role="status">Checking evidence / recording verdicts…</p>}
    </div>}
    {dialog && <Dialog title={dialog.note ? "Rejection note" : "Confirm bulk review"} close={() => answer(null)}>
      <form className="pc-form" onSubmit={event => { event.preventDefault(); answer(dialog.note ? note : "confirmed"); }}>
        <p className="pc-bulk-confirmation">{dialog.message}</p>
        {dialog.note && <label>Note<textarea value={note} required onInput={event => setNote(event.currentTarget.value)} /></label>}
        <div className="row-actions"><Button type="submit" variant="primary">Continue</Button><Button onClick={() => answer(null)}>Cancel</Button></div>
      </form>
    </Dialog>}
    {message && <p className="pc-bulk-result" role="status" aria-live="polite">{message}</p>}
    {children}
  </BulkSelection.Provider>;
}
