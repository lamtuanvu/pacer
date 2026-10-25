import {expect,test} from "bun:test";
import {workActionRequestId} from "../app/src/screens/work/WorkView";

test("work action IDs stay stable for one revision and advance for later attempts",()=>{
 const retry=workActionRequestId("t-20261025-123456-abcd",12,"retry");
 expect(workActionRequestId("t-20261025-123456-abcd",12,"retry")).toBe(retry);
 expect(workActionRequestId("t-20261025-123456-abcd",20,"retry")).not.toBe(retry);
 const answer=workActionRequestId("t-20261025-123456-abcd",21,"answer");
 expect(answer).not.toBe(retry);
 expect(workActionRequestId("t-20261025-123456-abcd",30,"answer")).not.toBe(answer);
});
