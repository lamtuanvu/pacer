import {expect,test} from "bun:test";
import {policyBeforeParams,policyDelegateAmend} from "../src/plugins/policy-protocol";
const input={goal:"work",repo:"repo",kind:null,requestedExecutor:null,placement:"auto"};
test("delegate read input preserves bounded custom dispatcher labels",()=>{
 for(const kind of ["custom-dispatch-label","x".repeat(128)]){const parsed=policyBeforeParams.parse({decision:"delegate",input:{...input,kind}});if(parsed.decision!=="delegate")throw Error("wrong decision");expect(parsed.input.kind).toBe(kind);}
 for(const kind of ["","x".repeat(129)])expect(policyBeforeParams.safeParse({decision:"delegate",input:{...input,kind}}).success).toBe(false);
});
test("custom labels remain forbidden amendments and review kinds",()=>{
 expect(policyDelegateAmend.safeParse({kind:"custom-dispatch-label"}).success).toBe(false);
 expect(policyBeforeParams.safeParse({decision:"review",input:{taskId:"task",revision:1,state:"done",verdict:"accept",kind:"custom-dispatch-label"}}).success).toBe(false);
 expect(policyDelegateAmend.safeParse({kind:"tests"}).success).toBe(true);
});
