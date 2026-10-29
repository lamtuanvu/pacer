import {expect,test} from "bun:test";
import {policyDetail,policyWords} from "../src/view-model/words";

test("policy words use the singular for one plugin (F10)",()=>{
 expect(policyWords({mode:"closed",plugins:1})).toBe("policy: closed (1 plugin)");
 expect(policyWords({mode:"closed",plugins:2})).toBe("policy: closed (2 plugins)");
 expect(policyDetail({mode:"closed",plugins:1})).toBe("policy: closed (1 plugin) · 1 enabled policy plugin");
 expect(policyDetail({mode:"open",plugins:0})).toBe("policy: open · 0 enabled policy plugins");
});
