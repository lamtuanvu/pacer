import {expect,test} from "bun:test";
import {policyCaption,policyDetail,policyWords} from "../src/view-model/words";

test("policy words use the singular for one plugin (F10)",()=>{
 expect(policyWords({mode:"closed",plugins:1})).toBe("policy: closed (1 plugin)");
 expect(policyWords({mode:"closed",plugins:2})).toBe("policy: closed (2 plugins)");
 expect(policyDetail({mode:"open",plugins:1})).toBe("1 enabled plugin · a failing plugin is ignored");
});
test("policy captions state the plugin count once (UI-15)",()=>{
 expect(policyCaption({mode:"closed",plugins:2})).toBe("policy: closed (2 plugins) · a failing plugin blocks the action");
 expect(policyCaption({mode:"open",plugins:0})).toBe("policy: open · 0 enabled plugins · a failing plugin is ignored");
 expect(policyCaption(undefined)).toBe("policy: unknown · not reported by this service");
 for(const policy of [{mode:"closed" as const,plugins:2},{mode:"open" as const,plugins:2}])expect(policyCaption(policy).match(/\b2\b/g)).toHaveLength(1);
});
