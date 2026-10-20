import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/task-get.json";
import type { TaskDetail } from "../src/core/task-detail";
import { TaskResultView } from "../app/src/screens/TaskResult";
const task=fixture as unknown as TaskDetail;
test("completed result keeps verdict optional and transcript collapsed",()=>{
 const html=renderToString(<TaskResultView task={{...task,reviewRequest:undefined}} verdict={<span>Verdict form</span>}/>);
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
