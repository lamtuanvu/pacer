import { SectionHeading } from "../../ds/SectionHeading";
import type { RefObject } from "preact";
import type { TaskDetail } from "../../../../src/core/task-detail";
import { executorLabel } from "../../../../src/view-model/words";
import { Button } from "../../ds/Button";
import { kinds } from "../../model/tasks";
import type { Verdict } from "./model";

export function verdictCommand(id: string, v: Verdict): string {
  // Double quotes keep the command readable; escape every shell expansion within them.
  const quote = (s: string) => '"' + s.replace(/[\\$\x60"]/g, c => "\\" + c) + '"';
  const word = (s: string) => /^[a-zA-Z0-9_./:@#-]+$/.test(s) ? s : quote(s);
  const flag = v.verdict === "retry" ? `retry-on ${word(v.executor ?? "")}` : v.verdict === "send_back" ? "send-back" : v.verdict;
  return `pacer review ${word(id)} --${flag}${v.kind ? ` --kind ${word(v.kind)}` : ""}${v.note?.trim() ? ` --note ${quote(v.note)}` : ""}`;
}
export function handleNoteKey(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "preventDefault" | "stopPropagation">,
  submit: () => void, cancel: () => void,
) {
  if (event.isComposing) return;
  if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Escape") cancel(); else submit();
  }
}
export interface VerdictPanelProps {
  task: TaskDetail; note: string; kind: string; executor: string;
  noteFor: "reject" | "send_back" | null; pending: boolean;
  onNote: (s: string) => void; onKind: (s: string) => void; onExecutor: (s: string) => void;
  onOpenNote: (v: "reject" | "send_back") => void; onCancel: () => void; onSubmit: (v: Verdict["verdict"]) => void;
  noteRef?: RefObject<HTMLTextAreaElement>; retryRef?: RefObject<HTMLSelectElement>;
}
export function VerdictPanel({ task, note, kind, executor, noteFor, pending, onNote, onKind, onExecutor, onOpenNote, onCancel, onSubmit, noteRef, retryRef }: VerdictPanelProps) {
  const verdict = noteFor ?? (executor ? "retry" : "accept");
  return <>
    <SectionHeading>Your verdict</SectionHeading>
    <Button variant="primary" disabled={pending} onClick={() => onSubmit("accept")}>Accept and bring back</Button>
    <p className="muted">Accept records the verdict; you merge the branch.</p>
    <div className="pc-verdict-pair"><Button disabled={pending} onClick={() => onOpenNote("send_back")}>Send back</Button>
    <Button className="pc-review-reject" disabled={pending} onClick={() => onOpenNote("reject")}>Reject</Button></div>
    <div className="pc-retry"><SectionHeading as="label" htmlFor="review-retry">Or retry on</SectionHeading><div className="row"><select className="pc-select" id="review-retry" ref={retryRef} value={executor} disabled={pending} onChange={e => onExecutor(e.currentTarget.value)}>
        <option value="">Choose an executor</option>
        {task.retryOptions.map(option => <option key={option.id} value={option.id} disabled={option.state !== "ready"}>{executorLabel(option.id)} · {option.reason}</option>)}
      </select>
    <Button disabled={pending || !executor} onClick={() => onSubmit("retry")}>Retry</Button></div></div>
    <label className="field">Kind (corrects the classifier)
      <select className="pc-select" value={kind} disabled={pending} onChange={e => onKind(e.currentTarget.value)}>
        <option value="">Unspecified</option>
        {task.kind && !kinds.includes(task.kind) && <option value={task.kind}>{task.kind}</option>}
        {kinds.map(k => <option key={k} value={k}>{k}</option>)}
      </select>
      <span className="muted">{task.routing?.kindSource ?? "No kind source"}</span>
    </label>
    <label className="field"><SectionHeading as="span">Note</SectionHeading>
      <textarea ref={noteRef} rows={5} value={note} disabled={pending} onInput={e => onNote(e.currentTarget.value)} onKeyDown={e => {
        if (noteFor) handleNoteKey(e, () => onSubmit(noteFor), onCancel);
      }} />
    </label>
    {noteFor && <div className="row-actions"><Button disabled={pending} onClick={() => onSubmit(noteFor)}>{noteFor === "reject" ? "Confirm rejection" : "Confirm send back"}</Button><Button disabled={pending} onClick={onCancel}>Cancel</Button><span className="muted">Enter to confirm · Shift-Enter for a new line · Escape to cancel</span></div>}
    <footer><details className="pc-disclosure"><summary>Use the CLI</summary><code className="pc-review-command">{verdictCommand(task.id, { verdict, ...(kind ? { kind } : {}), ...(note ? { note } : {}), ...(verdict === "retry" && executor ? { executor } : {}) })}</code></details></footer>
  </>;
}
