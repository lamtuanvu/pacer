import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/task-get.json";
import type { TaskDetail } from "../src/core/task-detail";
import { TaskResultView } from "../app/src/screens/TaskResult";
const task=fixture as unknown as TaskDetail;
test("completed result keeps verdict optional and transcript collapsed",()=>{
 const html=renderToString(<TaskResultView task={{...task,reviewRequest:undefined}} verdict={<span>Verdict form</span>}/>);
 expect(html).toContain("pc-page--wide");
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
