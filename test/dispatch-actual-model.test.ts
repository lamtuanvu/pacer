import {expect,test} from "bun:test";
import {observedAttemptModel} from "../src/tasks/runner";
test("only structured executor identity counts as actual model evidence",()=>{
 expect(observedAttemptModel("claude-code#team",'{"type":"system","subtype":"init","model":"claude-sonnet-4"}\n')).toBe("claude-sonnet-4");
 expect(observedAttemptModel("claude-code#team",'I used model claude-sonnet-4')).toBeNull();
 expect(observedAttemptModel("codex",'{"type":"system","subtype":"init","model":"claude-sonnet-4"}')).toBeNull();
});
