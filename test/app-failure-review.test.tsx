import { describe, expect, test } from "bun:test";
import { resolveRoute, hrefFor, routes, primaryFor, pageOwnsTitle } from "../app/src/router";
import { acceptanceRows, retryRequest, reviewAvailable } from "../app/src/screens/failure/model";
import type { TaskDetail } from "../src/core/task-detail";
const task = (extra = {}) => ({ id:"task-1", rev:3, state:"failed", attempts:[], acceptance:{cmd:"bun run typecheck && bun test",state:"failed",tail:"test failed",durationS:12}, ...extra }) as unknown as TaskDetail;
describe("failure and review routes", () => {
  test("round trip and navigation", () => {
    for (const [target, name] of [[routes.failure("a b"),"task-failure"],[routes.reviewTask("a b"),"task-review"]] as const) {
      const route = resolveRoute(hrefFor(target));
      expect(route).toMatchObject({ name, id:"a b" });
      if (!("redirect" in route)) { expect(primaryFor(route)).toBe("review"); expect(pageOwnsTitle(route)).toBe(true); }
    }
    expect(resolveRoute("#/tasks/x/review/invalid")).toMatchObject({name:"dispatch"});
  });
  test("does not invent per-command results from a shell expression", () => {
    expect(acceptanceRows(task())).toEqual([{cmd:"bun run typecheck && bun test",state:"failed",output:"test failed",durationS:12}]);
  });
  test("retry preserves lineage and note; managed retries cannot choose an executor", () => {
    expect(retryRequest(task({work:{rootId:"task-1"}}),"codex","fix it")).toEqual({op:"dispatch.retry",params:{id:"task-1",expect_rev:3,requestId:"task-1.3.retry",feedback:"fix it"}});
    expect(() => retryRequest(task({executor:"other"}),"codex","fix it")).toThrow("cannot pass feedback");
    expect(retryRequest(task({executor:"codex"}),"codex","fix it")).toMatchObject({op:"task.review",params:{verdict:"send_back",note:"fix it",expect_rev:3}});
  });
  test("settled reviewed or superseded results cannot be reviewed again", () => {
    expect(reviewAvailable(task())).toBe(true);
    for (const extra of [{state:"running"},{review:{accepted:true}},{retriedBy:"next"},{dismissed:true}]) expect(reviewAvailable(task(extra))).toBe(false);
  });
});

import { numberDiffLines, splitDiffRows } from "../app/src/screens/review/model";
import { parseFilePatch } from "../app/src/model/diff";
test("diff hunk coordinates and split replacement alignment", () => {
  const patch = "@@ -8,2 +10,3 @@\n-old\n+new\n+extra\n context";
  const numbered = numberDiffLines(parseFilePatch(patch,"x").lines);
  expect(numbered[1]).toMatchObject({old:8,mark:"−",text:"old"});
  expect(numbered[2]).toMatchObject({next:10,mark:"+",text:"new"});
  const rows = splitDiffRows(numbered);
  expect(rows[1]).toMatchObject({before:{text:"old"},after:{text:"new"}});
  expect(rows[2]?.before).toBeUndefined();
  expect(rows[3]).toMatchObject({before:{old:9},after:{next:12}});
});

import { renderToString } from "preact-render-to-string";
import { ResultHeader } from "../app/src/screens/review/ResultPage";
import { Diff } from "../app/src/screens/review/Diff";
import detailFixture from "./fixtures/ui/task-get.json";
test("header preserves board breadcrumbs and review states without stale actions", () => {
  const detail = detailFixture as unknown as TaskDetail;
  const render = (extra = {}, requesting = false) => renderToString(<ResultHeader task={{...detail, ...extra}} query={{repo:"sample",scope:null}} requesting={requesting}/>);
  expect(render({review:null})).toContain("Waiting for review");
  expect(render({review:null},true)).toContain("Changes requested");
  expect(render({review:{accepted:true}})).toContain("Accepted");
  expect(render()).toContain("#/needs-you?repo=sample");
});
test("diff renders binary, empty and clipped states truthfully", () => {
  expect(renderToString(<Diff path="x" patch="" layout="unified"/>)).toContain("No diff available");
  expect(renderToString(<Diff path="x" patch="" binary layout="split"/>)).toContain("Binary file");
  const html = renderToString(<Diff path="x" patch="@@ -1 +1 @@\n-a\n+b" layout="split" truncated/>);
  expect(html).toContain("Split diff");
  expect(html).toContain("Showing the first 2,000 lines.");
  expect(html).not.toContain("Copy worktree path");
});

import { retryReviewedWork } from "../app/src/screens/review/model";
test("managed request changes retries the rejected work with its fresh revision and feedback", async () => {
  const calls: {op:string;params:unknown}[] = [];
  const call = async <T,>(op:string,params:unknown):Promise<T> => {calls.push({op,params});return (op === "task.get" ? {rev:8} : {id:"task-1"}) as T;};
  await retryReviewedWork("task-1","  Fix the race.  ",call);
  expect(calls).toEqual([{op:"task.get",params:{id:"task-1"}},{op:"dispatch.retry",params:{id:"task-1",expect_rev:8,requestId:"task-1.8.retry",feedback:"Fix the race."}}]);
  const failing = async <T,>():Promise<T> => {throw new Error("task changed");};
  expect(retryReviewedWork("task-1","note",failing)).rejects.toThrow("task changed");
});

import { canOpenResultFile } from "../app/src/screens/review/model";
test("resolution alone does not prevent a legacy review retry", () => {
  expect(reviewAvailable(task({resolved:"worktree removed"}))).toBe(true);
});
test("file preview requires a current local direct run and a readable selected file", () => {
  const detail = task({backend:"direct",machine:null,attempts:[{}],files:[{path:"a.ts",status:"modified",binary:false}]});
  const session = {host:"builtin" as const,machine:null,attempt:1};
  expect(canOpenResultFile(detail, session, "a.ts")).toBe(true);
  for (const extra of [{backend:"orca"},{backend:null},{machine:"remote"},{attempts:[]}]) expect(canOpenResultFile({...detail,...extra},session,"a.ts")).toBe(false);
  for (const extra of [{host:"orca" as const},{machine:"remote"},{attempt:null},{attempt:2}]) expect(canOpenResultFile(detail,{...session,...extra},"a.ts")).toBe(false);
  expect(canOpenResultFile(detail,undefined,"a.ts")).toBe(false);
  expect(canOpenResultFile(detail,session,"missing.ts")).toBe(false);
  for (const extra of [{status:"deleted" as const},{binary:true}]) expect(canOpenResultFile({...detail,files:[{...detail.files[0]!,...extra}]},session,"a.ts")).toBe(false);
});
