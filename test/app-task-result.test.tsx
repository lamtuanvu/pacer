import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/task-get.json";
import type { TaskDetail } from "../src/core/task-detail";
import { TaskResultView } from "../app/src/screens/TaskResult";
const task=fixture as unknown as TaskDetail;
test("completed result keeps verdict optional and transcript collapsed",()=>{
 const html=renderToString(<TaskResultView task={{...task,reviewRequest:undefined}} verdict={<span>Verdict form</span>}/>);
 expect(html).toContain("pc-page--full");
 expect(html).toContain("pc-page-columns");
 expect(html).toContain("pc-action-panel");
 expect(html).toContain("Outcome not recorded");
 expect(html).toContain("Integration not recorded");
 expect(html).not.toContain("Accept and bring back");
 expect(html.indexOf("Result</")).toBeLessThan(html.indexOf("Executor transcript"));
 expect(html).toMatch(/<details[^>]*><summary[^>]*>.*?Executor transcript/);
 expect(html).toContain("Optional verdict");
});
test("explicit human handoff shows request while failures stay prominent",()=>{
 const html=renderToString(<TaskResultView task={{...task,acceptance:{...task.acceptance,state:"failed"},reviewRequest:{note:"Check access permissions",at:1}}} verdict={<span>Verdict form</span>}/>);
 expect(html).toContain("Check access permissions");
 expect(html).toContain("Checks failed");
 expect(html).toContain("Verdict form");
 expect(html).not.toContain("Optional verdict");
});

test("failed checks make recovery actions visible without asking for an acceptance",()=>{
 const html=renderToString(<TaskResultView task={{...task,reviewRequest:undefined,acceptance:{...task.acceptance,state:"failed"}}} verdict={<span>Send back</span>}/>);
 expect(html).not.toContain("Optional verdict");
 expect(html).toContain("Send back");
});

test("failed and limited executions expose recovery without calling them complete",()=>{
 for(const state of ['failed','limit'] as const){
  const html=renderToString(<TaskResultView task={{...task,state,reviewRequest:undefined,acceptance:{...task.acceptance,state:'none'}}} verdict={<span>Retry</span>}/>);
  expect(html).not.toContain('No acknowledgment required');
  expect(html).not.toContain('Optional verdict');
  expect(html).toContain('Retry');
 }
});

test("changes show every file and explain an empty patch",async()=>{
 const {ResultChanges}=await import('../app/src/screens/TaskResult');
 const patch='diff --git a/first.txt b/first.txt\n--- a/first.txt\n+++ b/first.txt\n@@ -0,0 +1 @@\n+first\ndiff --git a/second.txt b/second.txt\n--- a/second.txt\n+++ b/second.txt\n@@ -0,0 +1 @@\n+second\n';
 const html=renderToString(<ResultChanges patch={patch} untracked={[]} truncated={false}/>);
 expect(html).toContain('+first');expect(html).toContain('+second');
 const empty=renderToString(<ResultChanges patch="" untracked={[]} truncated={false}/>);
 expect(empty).toContain('No changes recorded');expect(empty).not.toContain('<pre');
});

test("result heading prefers the short name and keeps the full brief available", () => {
 const html = renderToString(<TaskResultView task={{...task, title:"Batch outbox settlement", fullTitle:"A very long instruction", brief:{...task.brief, goal:"A very long instruction"}}}/>);
 expect(html).toMatch(/<h2[^>]*>Batch outbox settlement<\/h2>/);
 expect(html).not.toMatch(/<h2[^>]*>A very long instruction<\/h2>/);
 expect(html).toContain("A very long instruction");
});

test("task workspace keeps route navigation and four task views", async () => {
 const {TaskDetailFrame} = await import("../app/src/screens/TaskResult");
 for (const tab of ["session", "changes", "brief", "result"]) {
  const html = renderToString(<TaskDetailFrame task={{...task,title:"Short task name"}} query={{repo:"acme/api",scope:"mine"}} tab={tab} onTab={()=>{}} navigator={<nav aria-label="Task navigator">Tasks</nav>}><p>Selected content</p></TaskDetailFrame>);
  expect(html).toContain('href="#/tasks?repo=acme%2Fapi&amp;scope=mine"');
  expect(html).toContain('class="pc-task-workspace"');
  expect(html).toContain('aria-label="Task navigator"');
  expect(html).toContain('role="tablist"');
  expect(html).toContain(`id="task-t-0412-${tab}-tab" role="tab" aria-selected="true"`);
  expect(html).toContain(`role="tabpanel" id="task-t-0412-${tab}-panel" aria-labelledby="task-t-0412-${tab}-tab"`);
  expect(html.match(/>Short task name<\/h2>/g)?.length).toBe(1);
  expect(html).toContain("Selected content");
  expect(html).not.toContain('>All tasks</a>');
 }
});

test("dispatched task adds Work to the split workspace views", async () => {
 const {TaskDetailFrame} = await import("../app/src/screens/TaskResult");
 const dispatched={...task,work:{} as TaskDetail["work"]};
 const html=renderToString(<TaskDetailFrame task={dispatched} query={{repo:null,scope:null}} tab="work" onTab={()=>{}}><p>Dispatch history</p></TaskDetailFrame>);
 expect(html).toContain('id="task-t-0412-work-tab" role="tab" aria-selected="true"');
 expect(html).toContain('role="tabpanel" id="task-t-0412-work-panel" aria-labelledby="task-t-0412-work-tab"');
 expect(html).toContain('Dispatch history');
});

test("managed questions stay in Work rather than invoking the legacy answer action", async () => {
 const {legacyQuestionPending}=await import("../app/src/screens/TaskResult");
 const needsInput={...task,state:"needs_input" as const,question:{text:"Which format?",at:1}};
 expect(legacyQuestionPending(needsInput)).toBe(true);
 expect(legacyQuestionPending({...needsInput,work:{} as TaskDetail["work"]})).toBe(false);
});

test("managed results direct review to Work instead of legacy verdict actions", async () => {
 const {legacyReviewAvailable}=await import("../app/src/screens/TaskResult");
 const managed={...task,state:"done" as const,work:{} as TaskDetail["work"],reviewRequest:{note:"Review children",at:1}};
 expect(legacyReviewAvailable({...managed,work:undefined},true)).toBe(true);
 expect(legacyReviewAvailable(managed,true)).toBe(false);
 const html=renderToString(<TaskResultView task={managed} verdict={<button>Accept</button>}/>);
 expect(html).toContain("Use the Work tab for decisions and history.");
 expect(html).not.toContain("<button>Accept</button>");
});

test("active task summaries never claim that execution ended", () => {
 for (const state of ["running", "queued"] as const) {
  const html = renderToString(<TaskResultView task={{...task,state,summary:null,reviewRequest:undefined}}/>);
  expect(html).not.toContain("Execution ended");
  expect(html).not.toContain("Execution finished");
  expect(html).toContain(state === "running" ? "Execution is in progress" : "Waiting to start");
 }
});
