import { render } from "preact";
import snapshot from "./snapshot.json";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { ActionContext } from "../../../app/src/data/action-context";
import { createActionRunner } from "../../../app/src/data/actions";
import { initialState } from "../../../app/src/data/store";
import { ApiError } from "../../../app/src/data/api";
import { Failure } from "../../../app/src/screens/failure/Failure";
import { NeedsYouPage } from "../../../app/src/screens/needs-you/NeedsYou";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { useEffect, useState } from "preact/hooks";
const snap = structuredClone(snapshot) as unknown as ClientSnapshot;
const managed = location.search.includes("managed");
const unsupported = location.search.includes("unsupported");
let question = { ...snap.tasks[0]!, id: "question", ...(managed ? {work:{rootId:"question",parentId:null,depth:0}} : {}), state: "needs_input", title: "A question about the update plan", executor: "codex", rev: 7, question: { text: "Hide the expired plan?", at: snap.at - 2280, options: ["Hide it", "Keep it visible"] } };
snap.tasks.push(question);
snap.attention = [{ id: "question", taskId: "question", kind: "question", severity: "decide", repo: question.repo!, title: question.title, detail: question.question.text, raisedAt: snap.at - 2280, since: snap.at - 2280, actions: [{ label: "Answer", op: "task.answer", params: { id: "question" } }], notify: "important" }, ...(snap.attention ?? [])];
const controls = window as unknown as { actionMode: string; actionCalls: {op:string;params:unknown}[]; releaseAction: () => void };
controls.actionCalls = [];
let failedTask = { ...question, id:"managed-failed", state:"failed", title:"Managed failed work", fullTitle:"Managed failed work", question:null, brief:{goal:"Managed failed work",repo:"$HOME/repo"}, acceptance:{state:"failed",checks:[]}, attempts:[], work:{rootId:"managed-failed",parentId:null,depth:0} };
if (location.search.includes("failed")) {
 snap.tasks.push(failedTask as never);
 snap.attention = [{id:"managed-failed",taskId:"managed-failed",kind:"failed",severity:"decide",repo:question.repo!,title:failedTask.title,detail:"Checks failed",raisedAt:snap.at,since:snap.at,actions:[],notify:"important"}, ...(snap.attention ?? [])];
}
(window as any).refreshFixture = () => {
  question = {...question, rev:8}; failedTask = {...failedTask, rev:8};
  snap.tasks = snap.tasks.map(task => task.id === "question" ? question as never : task.id === "managed-failed" ? failedTask as never : task);
};
const api = { call: async <T,>(op: string, params: unknown): Promise<T> => {
  if (op === "task.retry_options") return [] as T;
  if (op === "task.get") return { ...question, branch: "fix/stale-plan" } as T;
  if (op === "task.log") return ((params as { stdout?: number }).stdout ? { stdout: "Reproduced stale plan\nWaiting for your answer", stderr: "", next: { stdout: 262200, stderr: 0 } } : { stdout: "Earlier output", stderr: "", next: { stdout: 262144, stderr: 0 } }) as T;
  if (op === "dispatch.answer" || op === "dispatch.retry") {
    controls.actionCalls.push({op,params});
    if (controls.actionMode === "hold") await new Promise<void>(resolve => { controls.releaseAction = resolve; });
    if (controls.actionMode === "conflict") throw new ApiError("conflict", "Revision changed", undefined, 409);
    if (controls.actionMode === "error") throw new Error("Service temporarily unavailable");
  }
  if (op === "task.answer" || op === "dispatch.answer") { (window as unknown as { answer: unknown, answerOp: string }).answerOp = op; (window as unknown as { answer: unknown }).answer = params; return {} as T; }
  return {} as T;
}, hello: async () => ({} as never), snapshot: async () => ({ protocol: "3.0.0", seq: snap.seq, snapshot: snap }) };
const runner = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: hash => { location.hash = hash; } });
function Fixture() {
  const [, tick] = useState(0);
  useEffect(() => { const change = () => tick(v => v + 1); window.addEventListener("hashchange", change); return () => window.removeEventListener("hashchange", change); }, []);
  return <ActionContext.Provider value={runner}><TaskContext.Provider value={{ state: { ...initialState(), features: {readModel:true,ops:new Set(unsupported ? [] : ["dispatch.answer", "dispatch.retry"])}, snapshot: snap, connected: true }, api }}><div className="pc-app pc-app--with-status"><main id="main-content" tabIndex={-1}>{location.hash.startsWith("#/tasks/managed-failed/failure") ? <Failure task={failedTask as never} query={{repo:null,scope:null}} reload={() => {}} tree={{nodes:[{taskId:"managed-failed",retryEligibility:{allowed:true}}]} as never} retryOnly /> : <NeedsYouPage query={{ repo: null, scope: null }} />}</main></div></TaskContext.Provider></ActionContext.Provider>;
}
render(<Fixture />, document.getElementById("fixture")!);
