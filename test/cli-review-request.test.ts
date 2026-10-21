import { expect, test } from "bun:test";
import { main } from "../src/cli";
import { createTask, updateTask, readTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

test("CLI requests a human decision with revision protection", async () => {
 const ctx=fakeCtx();
 const t=createTask(ctx,{brief:{goal:"Check",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 updateTask(ctx,t.id,x=>{x.state="done";});
 const r=await main(["task","request-review",t.id,"--note","Check permissions","--expect-rev","2","--json"],ctx);
 expect(r.code).toBe(0);
 expect(JSON.parse(r.out)).toMatchObject({task:{reviewRequest:{note:"Check permissions"}}});
 expect(readTask(ctx,t.id)?.review).toBeUndefined();
 expect((await main(["task","request-review",t.id,"--note","Other","--expect-rev","2"],ctx)).code).toBe(2);
});
