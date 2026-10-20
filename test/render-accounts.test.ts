import { withLoginIndicators } from "./helpers";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { renderText } from "../src/render/text";
import { renderLine } from "../src/render/line";
import { toBudget } from "../src/link/budget";
import { emptySnapshot, parseSnapshot } from "../src/link/envelope";
import { buildExecutors, buildAccounts, buildPlanner } from "../src/api/read-model/capacity";
import type { Status } from "../src/engine/status";
import type { Strategy } from "../src/config/strategy";
import { renderDashboard } from "../src/dashboard/render";
import { main } from "../src/cli";
import { headline, rankedProviders, mutedProviders, providerLabel } from "../src/view-model/panel";
import { runnerLabel, renderRoute } from "../src/render/accounts";
import { fakeCtx } from "./helpers";

const raw = { accounts: { plan: {kind:"claude"}, team: {kind:"codex",home:"~/.codex-team"}, byteplus:{kind:"endpoint",usage:"unmetered",model:"api/code"} }, planner:"claude-code", routing:[{default:["opencode#byteplus","codex#team"]}] };
async function status() {
 const ctx=withLoginIndicators(fakeCtx());
 mkdirSync(join(ctx.home, ".codex-team"), {recursive:true});
 writeFileSync(join(ctx.home, ".codex-team/auth.json"), "{}");
 const reading={windows:[{name:"weekly",usedPct:34,resetsAt:ctx.now+3600,lengthS:604800,paced:true}],capturedAt:ctx.now,stale:false};
 return computeStatus(ctx,validateStrategy(raw,"test"),{profile:null,readings:new Map([["plan",reading],["team",reading]])});
}
// Current dashboards consume the service read model.
function boardSnapshot(st:Status, strategy:Strategy) {
 return {...emptySnapshot(),at:st.generatedAt,budget:toBudget(st),
  planner:buildPlanner(st),executors:buildExecutors(st,strategy,[],st.generatedAt),
  accounts:buildAccounts(st,strategy)};
}
test("account-form status identifies each runner and its agent/account",async()=>{
 const st=await status();
 expect(renderText(st)).toContain("Codex (team): weekly 34%");
 expect(renderText(st)).toContain("BytePlus: local, unmetered OK");
 expect(renderText(st)).toMatchSnapshot();
 expect(renderLine(st, { color: false })).toContain("Claude Code 34%");
 expect(renderLine(st).split("\n")).toHaveLength(1);
});
test("account metadata survives the link and appears in the dashboard",async()=>{
 const st=await status(), s=parseSnapshot({...emptySnapshot(),budget:toBudget(st)})!;
 const board=boardSnapshot(st,validateStrategy(raw,"test"));
 expect(s.budget!.providers.find(p=>p.id==="codex#team")).toMatchObject({account:"team",agent:"codex",usedPct:34});
 expect(renderDashboard(board,150,24,st.generatedAt,{selected:0,noColor:true})).toMatch(/Codex · team .*34%/);
 expect(renderDashboard(board,150,24,st.generatedAt,{selected:0,noColor:true,version:"0.2.3"}).split("\n").map(line=>line.trimEnd()).join("\n")).toMatchSnapshot();
 expect(renderDashboard(board,150,24,st.generatedAt,{selected:0,noColor:true}).split("\n")[1]).toContain("Claude");
});
test("usage-only accounts keep their measured budget in unavailable rows",async()=>{
 const st=await status(),p=st.providers.find(p=>p.id==="codex#team")!;
 p.unavailableReason="account folder not found";
 const s=parseSnapshot({...emptySnapshot(),budget:toBudget(st)})!;
 expect(rankedProviders(s).map(p=>p.id)).not.toContain("Codex (team)");
 expect(mutedProviders(s).find(p=>p.id==="codex#team")).toMatchObject({usedPct:34,account:"team",unavailableReason:"account folder not found"});
 expect(renderText(st)).toContain("usage-only · account folder not found · weekly 34%");
 expect(headline({...s.budget!.providers.find(p=>p.id==="codex#team")!,verdict:"AHEAD"})).toStartWith("Codex (team) is ahead");
});
test("shared accounts group runner rows without changing executor preference",async()=>{
 const st=await status(), first=st.providers.find(p=>p.id==="opencode#byteplus")!;
 // Render a shared-budget host row; remote execution remains reserved.
 st.providers.push({...first,id:"opencode#byteplus@desktop"});
 st.executors.ranked=[{id:"opencode#byteplus",score:2,verdict:"OK",reason:""},{id:"codex#team",score:1,verdict:"EXPIRING",reason:""},{id:"opencode#byteplus@desktop",score:0,verdict:"OK",reason:""}];
 const text=renderText(st);
 expect(text.indexOf("Account byteplus")).toBeLessThan(text.indexOf("BytePlus:"));
 expect(text.lastIndexOf("BytePlus:")).toBeLessThan(text.indexOf("Account team"));
 const strategy=validateStrategy(raw,"test");
 strategy.runners["opencode#byteplus@desktop"]={...strategy.runners["opencode#byteplus"]!,id:"opencode#byteplus@desktop",name:"opencode#byteplus@desktop",host:"desktop"};
 strategy.hosts.desktop={alias:"desktop",ssh:"desktop",maxTasks:3,repos:{},accounts:{}};
 const s=boardSnapshot(st,strategy);
 const dash=renderDashboard(s,150,30,st.generatedAt,{selected:0,noColor:true});
 // The board keeps service order and names each runner of the shared account.
 const rows=dash.split("\n").filter(line=>/^\s+\d\s+BytePlus/.test(line));
 expect(rows).toHaveLength(2);
 expect(dash).toMatch(/1\s+BytePlus\s/);
 expect(dash).toMatch(/2\s+Codex · team/);
 expect(dash).toMatch(/3\s+BytePlus on desktop/);
 expect(s.accounts.find(a=>a.name==="byteplus")?.executors).toEqual(["opencode#byteplus","opencode#byteplus@desktop"]);
 expect(s.budget.ranked.map(p=>p.id)).toEqual(["opencode#byteplus","codex#team","opencode#byteplus@desktop"]);
});
test("legacy strategies keep existing status and link presentation",async()=>{
 const ctx=fakeCtx(),st=await computeStatus(ctx,validateStrategy({planner:"claude-code",providers:{local:{via:"opencode",model:"api/code",usage:"unmetered"}}},"test"),{profile:null});
 expect(renderText(st)).toContain("- Local: local, unmetered OK");
 expect(renderText(st)).not.toContain("Account ");
 expect(toBudget(st).providers[0]).not.toHaveProperty("account");
 st.providers[0].unavailableReason="account folder not found";
 expect(renderText(st)).toContain("- Local: local, unmetered OK");
 expect(toBudget(st).providers[0]).not.toHaveProperty("unavailableReason");
});
test("list commands use aligned labeled columns and JSON retains its shape",async()=>{
 const ctx=withLoginIndicators(fakeCtx());mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,"strategy.yaml"),Bun.YAML.stringify(raw));
 const accounts=await main(["account","list"],ctx), runners=await main(["runner","list"],ctx);
 expect(accounts.code).toBe(0);expect(runners.code).toBe(0);
 expect(accounts.out.split("\n")[0].split(/\s{2,}/)).toEqual(["ACCOUNT","KIND","SOURCE","FOLDER","RUNNERS","USAGE"]);
 expect(runners.out.split("\n")[0].split(/\s{2,}/)).toEqual(["RUNNER","ACCOUNT","MODEL"]);
 for(const out of [accounts.out,runners.out]) {
  const lines=out.split("\n"), starts=[...lines[0].matchAll(/\S+/g)].map(m=>m.index!);
  for(const line of lines.slice(1)) for(const start of starts) expect(line[start]).not.toBe(" ");
 }
 expect(JSON.parse((await main(["runner","list","--json"],ctx)).out).find((r:any)=>r.id==="codex#team")).toMatchObject({agent:"codex",account:"team",model:null});
 const route=await main(["route"],ctx);
 expect(route.out).toContain("1. opencode#byteplus (BytePlus): ok");
 expect(route.out).not.toContain("Account ");
});

// Starter-shaped legacy strategies must retain main's human labels while ids stay canonical.
test("starter text preserves provider names and main route format", async () => {
 const ctx=withLoginIndicators(fakeCtx());
 const starter={planner:"claude-code",providers:{codex:{usage:"quota"},agy:{usage:"reactive"},byteplus:{via:"opencode",model:"api/code",usage:"unmetered"},local:{via:"opencode",model:"api/local",usage:"unmetered"}},routing:[{default:["codex","byteplus","local","agy"]}],pacing:{policy:"priority",order:["codex","byteplus","local","agy"]}};
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),Bun.YAML.stringify(starter));
 const logs=join(ctx.home,".codex","sessions");mkdirSync(logs,{recursive:true});
 writeFileSync(join(logs,"rollout-test.jsonl"),JSON.stringify({rate_limits:{primary:{used_percent:19,window_minutes:10080,resets_at:ctx.now+604800*0.82}}}));
 const st=await computeStatus(ctx,validateStrategy(starter,"test"),{profile:null});
 expect(renderText(st)).toContain("- BytePlus: local, unmetered OK");
 expect(renderText(st)).toContain("- Local: local, unmetered OK");
 expect(renderLine(st)).not.toContain("BytePlus");
 expect(renderLine(st)).not.toContain("Local");
 const snapshot=boardSnapshot(st,validateStrategy(starter,"test"));
 expect(renderDashboard(snapshot,150,24,ctx.now,{selected:0,noColor:true})).toContain("BytePlus");
 expect(renderDashboard(snapshot,150,24,ctx.now,{selected:0,noColor:true})).toContain("Local");
 expect(providerLabel(snapshot.budget.providers.find(p=>p.id==="opencode#byteplus")!)).toBe("BytePlus");
 const route=await main(["route"],ctx);
 expect(route.code).toBe(0);
 expect(route.out.split("\n").slice(0,4)).toEqual(["1. codex (Codex): on pace, used 19% / pace 18%","2. opencode#byteplus (BytePlus): ok","3. opencode#local (Local): ok","4. agy (Antigravity): ok, used 0%"]);
 expect(route.out).not.toContain("Account ");
 expect(JSON.parse((await main(["route","--json"],ctx)).out).ranked[1].id).toBe("opencode#byteplus");
});
test("named account labels and shared route headers", () => {
 expect(runnerLabel({id:"claude-code#work",agent:"claude-code",account:"work"})).toBe("Claude Code (work)");
 expect(runnerLabel({id:"codex#team",agent:"codex",account:"team"})).toBe("Codex (team)");
 expect(renderRoute([{id:"opencode#local",agent:"opencode",account:"local",index:0,reason:"ok"},{id:"codex",agent:"codex",account:"plan",index:1,reason:"on pace"},{id:"opencode#local@desktop",agent:"opencode",account:"local",index:2,reason:"ok"}])).toEqual(["Account local","1. opencode#local (Local): ok","3. opencode#local@desktop (Local): ok","2. codex (Codex): on pace"]);
});
