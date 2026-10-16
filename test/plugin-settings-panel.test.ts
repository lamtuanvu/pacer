import { expect, test } from "bun:test";
import { readPanelSettings } from "../orca-plugin/src/panel/settings";
test("remaining settings reader only reads the active strategy",()=>{
 const paths:string[]=[];
 const value=readPanelSettings(path=>{paths.push(path);return JSON.stringify({accounts:{personal:{kind:'claude'}},planner:'claude-code',routing:[{default:['claude-code']}],update_check:false});},"fixture");
 expect(paths).toEqual(["fixture/strategy.yaml"]);expect(value.strategyConfig?.planner.agent).toBe("claude-code");expect(value.updateCheck).toBe(false);
});
test("remaining settings reader handles missing and invalid configuration",()=>{
 expect(readPanelSettings(()=>null,"fixture")).toEqual({updateCheck:true});
 expect(readPanelSettings(()=>"[invalid","fixture").error).toContain("Settings unavailable");
});
