import { test, expect } from "bun:test";
import { renderPanel, jsonForScript, escapeHtml } from "../orca-plugin/src/panel";
import { emptySnapshot, type LinkSnapshot } from "../src/link/envelope";
test("panel escapes script injection and JSON script terminators",()=> {
 const s=emptySnapshot();s.tasks=[{id:"x",state:"running",goal:"</script><img src=x onerror=alert(1)>",executor:"<evil>",backend:null,worktree:null,updatedAt:100}];
 const html=renderPanel(s,{nowS:100,transport:null,reachable:false});expect(html).toContain("&lt;/script&gt;&lt;img");expect(html).not.toContain("<img src=x");
 expect(escapeHtml('&<>"\'')).toBe("&amp;&lt;&gt;&quot;&#39;");expect(jsonForScript("</script>\u2028\u2029")).toBe('"\\u003c/script>\\u2028\\u2029"');
 const json=html.match(/id="pacer-actions">(.*?)<\/script>/s)![1];expect(json).not.toContain("</script>");expect(()=>JSON.parse(json)).not.toThrow();
});
test("buttons require a live console and document has no external URLs",()=> {
 const s=emptySnapshot();for(const heartbeat of [null,69,100]){s.console=heartbeat===null?null:{handle:"term",paneKey:"pane",pid:1,startedAt:0,heartbeatAt:heartbeat};const html=renderPanel(s,{nowS:100,transport:"bridge",reachable:true});expect((html.match(/ disabled/g)||[]).length).toBe(heartbeat===100?0:3);expect(html).not.toMatch(/https?:/);expect(html).toContain("Reopen this panel to refresh.");if(heartbeat===100){const actions=JSON.parse(html.match(/id="pacer-actions">(.*?)<\/script>/s)![1]);expect(actions.delegate.terminalId).toBe("term");expect(actions.delegate.enter).toBe(true);expect(actions.delegate.text).toContain(": pacer '");}}
});
test("maximum-size snapshot renders under 64KiB and limits rows",()=> {
 const s:LinkSnapshot=emptySnapshot();s.budget={generatedAt:100,strategy:"s",planner:"p",mode:"normal",providers:Array.from({length:32},(_,i)=>({id:`p${i}`,verdict:"OK",usedPct:50,resetsAt:3700,window:"5h",stale:true})),ranked:Array.from({length:32},(_,i)=>({id:`executor${i}`,verdict:"OK"}))};s.tasks=Array.from({length:20},(_,i)=>({id:`t${i}`,state:"running",goal:"g".repeat(200),executor:"e",backend:null,worktree:null,updatedAt:100}));s.alerts=Array.from({length:10},(_,i)=>({key:`a${i}`,level:"warn",title:`alert${i}`,body:"b".repeat(1000),at:100}));const html=renderPanel(s,{nowS:100,transport:"http",reachable:true});expect(Buffer.byteLength(html)).toBeLessThan(65536);expect(html).toContain("resets in 1.0h");expect(html).toContain("stale");expect(html).not.toContain("executor5");expect(html).not.toContain("alert5");
});

test("an open panel never sends after its advertised heartbeat expires", async()=> {
 const {runInNewContext}=await import("node:vm");
 const s=emptySnapshot();s.console={handle:"term",paneKey:"pane",pid:1,startedAt:0,heartbeatAt:100};
 const html=renderPanel(s,{nowS:100,transport:"bridge",reachable:true});
 const data=html.match(/id="pacer-actions">(.*?)<\/script>/s)![1];const script=html.match(/<script>\n([\s\S]*?)<\/script>/)![1];
 let now=130000;const sent:any[]=[];let click!:()=>void;const status={textContent:""};const button={dataset:{action:"delegate"},disabled:false,addEventListener:(_n:string,h:()=>void)=>click=h};
 const parent={postMessage:(v:any)=>sent.push(v)};
 runInNewContext(script,{Date:{now:()=>now},document:{getElementById:(id:string)=>id==="pacer-actions"?{textContent:data}:status,querySelectorAll:()=>[button]},window:{parent,addEventListener:()=>{}}});
 click();expect(sent).toHaveLength(1);now=130001;click();expect(sent).toHaveLength(1);expect(button.disabled).toBe(true);expect(status.textContent).toContain("Reopen");
});

test("panel sends at most thirty action messages in ten seconds",async()=> {
 const {runInNewContext}=await import("node:vm");
 const s=emptySnapshot();s.console={handle:"term",paneKey:"pane",pid:1,startedAt:0,heartbeatAt:100};
 const html=renderPanel(s,{nowS:100,transport:"bridge",reachable:true});
 const data=html.match(/id="pacer-actions">(.*?)<\/script>/s)![1];const script=html.match(/<script>\n([\s\S]*?)<\/script>/)![1];
 let now=100000;const sent:any[]=[];let click!:()=>void;const status={textContent:""};const button={dataset:{action:"delegate"},disabled:false,addEventListener:(_n:string,h:()=>void)=>click=h};
 runInNewContext(script,{Date:{now:()=>now},document:{getElementById:(id:string)=>id==="pacer-actions"?{textContent:data}:status,querySelectorAll:()=>[button]},window:{parent:{postMessage:(v:any)=>sent.push(v)},addEventListener:()=>{}}});
 for(let i=0;i<31;i++)click();expect(sent).toHaveLength(30);now+=10000;click();expect(sent).toHaveLength(31);
});
