import { renderToString } from "preact-render-to-string";
import { NavigationProvider } from "../app/src/navigation";
import { TaskAside } from "../app/src/screens/session/TaskAside";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import type { BrowserApi } from "../app/src/data/api";
import type { TaskNodeView } from "../src/view-model/task-tree";
import { describe, expect, test } from "bun:test";
import { hrefFor, resolveRoute, routes, pageOwnsTitle, type Route } from "../app/src/router";
import { candidateAgent, decisionCaption, executorTokenRole, tokenValue, traceSteps, traceCandidates, traceStepState } from "../app/src/screens/trace/model";
import type { TaskDetail } from "../src/core/task-detail";

describe("dispatch trace", () => {
  test("trace and review deep links preserve task identity and scope", () => {
    const target = routes.trace("task /1", { repo: "repo" });
    expect(hrefFor(target)).toBe("#/tasks/task%20%2F1/trace?repo=repo");
    const resolved = resolveRoute(hrefFor(target));
    expect(resolved).toMatchObject({name:"sessions", id:"task /1", view:"trace", query:{repo:"repo"}});
    if ("name" in resolved) expect(pageOwnsTitle(resolved)).toBe(true);
    expect(resolveRoute("#/tasks/task%20%2F1/review")).toMatchObject({name:"task-review",id:"task /1"});
    expect(resolveRoute("#/tasks/%XX/trace")).toMatchObject({name:"dispatch"});
  });
  test("Tasks aside trace link retains the active repo filter", () => {
    const route:Route={name:"sessions",query:{repo:"team/repo",scope:null}};
    const node={id:"root",title:"Root task",agents:[],state:{tone:"good",label:"Completed",live:false},attention:"none"} as unknown as TaskNodeView;
    const html=renderToString(<TaskContext.Provider value={{state:initialState(),api:{} as BrowserApi}}><NavigationProvider route={route} location={{hash:"#/tasks",replace(){}}}><TaskAside node={node} position="Root task" href={id=>`#/tasks/${id}`} viewHref={id=>`#/tasks/${id}`}/></NavigationProvider></TaskContext.Provider>);
    expect(html).toContain('href="#/tasks/root/trace?repo=team%2Frepo"');
  });
  test("unmeasured tokens stay unknown and partial totals retain coverage", () => {
    expect(tokenValue(undefined)).toBe("Not recorded");
    expect(tokenValue({total:0,measuredAttempts:0,partialAttempts:0})).toBe("Not recorded");
    expect(tokenValue({total:0,measuredAttempts:1,partialAttempts:0})).toBe("0");
    expect(tokenValue({total:1200,measuredAttempts:0,partialAttempts:1,lowerBound:true})).toBe("≥ 1.2k");
  });
  test("candidate identities use stored runner bindings and never infer a selection", () => {
    expect(candidateAgent('["codex",{"kind":"default"}]')).toBe("codex");
    expect(candidateAgent("unknown")).toBe("unknown");
    expect(traceCandidates({attempt:1,proposal:{state:"ranked",choices:[{id:'["codex",{}]',reason:"ok"}]}})[0]?.verdict).toBe("Eligible");
  });
  test("nullable engine proposals and missing selection remain displayable", () => {
    expect(traceCandidates({attempt:1,proposal:null})).toEqual([]);
    expect(decisionCaption({attempt:1,proposal:null})).toBe("Not recorded");
    expect(decisionCaption({attempt:2,proposal:{state:"ranked",step:"capable-with-headroom"}})).toContain("capable with spare capacity");
  });
  test("candidate captions identify the subtask and keep absent decisions unknown", () => {
    expect(decisionCaption()).toBe("No alternatives were recorded for this step.");
    expect(decisionCaption(undefined,undefined,true)).toBe("From the routing record; no dispatch decision was stored.");
    expect(decisionCaption({attempt:3,proposal:null},2)).toBe("Subtask 2 · Not recorded");
  });
  test("executor token roles count subtasks once across retries and accounts", () => {
    const children=[{attempts:[{executor:"codex#team"},{executor:"codex#personal"}]},{attempts:[{executor:"codex"},{executor:"agy"}]}] as unknown as Parameters<typeof executorTokenRole>[2];
    expect(executorTokenRole("codex",3,children)).toBe("2 subtasks");
    expect(executorTokenRole("agy",1,children)).toBe("1 subtask");
    expect(executorTokenRole("codex",2,[])).toBe("2 attempts");
    expect(executorTokenRole("codex",1,[])).toBe("1 attempt");
  });
  test("step glyphs and rails follow completed, current, failed and queued states", () => {
    const task={state:"running"} as TaskDetail;
    expect(traceStepState(task,0,2)).toEqual({tone:"done",glyph:"✓",rail:true});
    expect(traceStepState(task,1,2)).toEqual({tone:"current",glyph:"◐",rail:false});
    expect(traceStepState({...task,state:"failed"},1,2)).toEqual({tone:"failed",glyph:"✕",rail:false});
    expect(traceStepState({...task,state:"partial",acceptance:{state:"failed"}} as TaskDetail,1,2).tone).toBe("failed");
    expect(traceStepState({...task,state:"queued"},1,2)).toEqual({tone:"neutral",glyph:"2",rail:false});
    expect(traceStepState({...task,state:"done"},1,2).tone).toBe("current");
    expect(traceStepState({...task,state:"done",review:{accepted:true}} as TaskDetail,1,2).tone).toBe("done");
  });
  test("routing timeline entries are enriched rather than duplicated", () => {
    const task={timeline:[{at:10,text:"Routed to codex"}],routing:{chosen:"codex",why:"available"},startedAt:10} as TaskDetail;
    expect(traceSteps(task,undefined)).toHaveLength(1);
    expect(traceSteps(task,undefined)[0]?.title).toBe("Routed to Codex");
  });
  test("legacy retries keep each known routing event", () => {
    const task={timeline:[{at:10,text:"Routed to Codex · available"},{at:20,text:"Routed to Antigravity · available"}],routing:{chosen:"agy",why:"available"},startedAt:10,attempts:[{startedAt:10,routing:{chosen:"codex",why:"available"}},{startedAt:20,routing:{chosen:"agy",why:"available"}}]} as TaskDetail;
    const steps=traceSteps(task,undefined);
    expect(steps).toHaveLength(2);
    expect(steps.map(s=>s.at)).toEqual([10,20]);
    expect(steps.map(s=>s.title)).toEqual(["Routed to Codex","Routed to Antigravity"]);
  });
  test("running retry retains pending routing after completed attempts", () => {
    const task={timeline:[],routing:{chosen:"agy",why:"available"},startedAt:10,attemptStartedAt:30,attempts:[{startedAt:10,routing:{chosen:"codex",why:"available"}}]} as unknown as TaskDetail;
    expect(traceSteps(task,undefined).map(s=>s.at)).toEqual([10,30]);
  });
  test("timeline is chronological and does not manufacture classification or splitting", () => {
    const task = {timeline:[{at:20,text:"done"},{at:10,text:"queued"}]} as TaskDetail;
    const steps = traceSteps(task, undefined);
    expect(steps.map(s=>s.at)).toEqual([10,20]);
    expect(steps.map(s=>s.title)).toEqual(["Run queued","Run completed"]);
    expect(steps.every(s=>s.tokens==="Not recorded")).toBe(true);
  });
});
