import { render } from "preact";
import snapshot from "./snapshot.json";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { ActionContext } from "../../../app/src/data/action-context";
import { createActionRunner } from "../../../app/src/data/actions";
import { initialState } from "../../../app/src/data/store";
import { NeedsYouPage } from "../../../app/src/screens/needs-you/NeedsYou";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { useEffect, useState } from "preact/hooks";
const snap = structuredClone(snapshot) as unknown as ClientSnapshot;
const question = { ...snap.tasks[0]!, id: "question", state: "needs_input", title: "A question about the update plan", executor: "codex", rev: 7, question: { text: "Hide the expired plan?", at: snap.at - 2280, options: ["Hide it", "Keep it visible"] } };
snap.tasks.push(question);
snap.attention = [{ id: "question", taskId: "question", kind: "question", severity: "decide", repo: question.repo!, title: question.title, detail: question.question.text, raisedAt: snap.at - 2280, since: snap.at - 2280, actions: [{ label: "Answer", op: "task.answer", params: { id: "question" } }], notify: "important" }, ...(snap.attention ?? [])];
const api = { call: async <T,>(op: string, params: unknown): Promise<T> => {
  if (op === "task.get") return { ...question, branch: "fix/stale-plan" } as T;
  if (op === "task.log") return ((params as { stdout?: number }).stdout ? { stdout: "Reproduced stale plan\nWaiting for your answer", stderr: "", next: { stdout: 262200, stderr: 0 } } : { stdout: "Earlier output", stderr: "", next: { stdout: 262144, stderr: 0 } }) as T;
  if (op === "task.answer") { (window as unknown as { answer: unknown }).answer = params; return {} as T; }
  return {} as T;
}, hello: async () => ({} as never), snapshot: async () => ({ protocol: "3.0.0", seq: snap.seq, snapshot: snap }) };
const runner = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: hash => { location.hash = hash; } });
function Fixture() {
  const [, tick] = useState(0);
  useEffect(() => { const change = () => tick(v => v + 1); window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
  return <ActionContext.Provider value={runner}><TaskContext.Provider value={{ state: { ...initialState(), snapshot: snap, connected: true }, api }}><div className="pc-app pc-app--with-status"><NeedsYouPage query={{ repo: null, scope: null }} /></div></TaskContext.Provider></ActionContext.Provider>;
}
render(<Fixture />, document.getElementById("fixture")!);
