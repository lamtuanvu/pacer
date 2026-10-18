import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { RepoRef } from "../src/api/read-model/types";
import { capacity, counts, doneToday, needsYou, otherReposNeedingYou, running } from "../src/view-model/selectors";
import { phaseWords, taskStatus } from "../src/view-model/words";
import { renderStatusPage } from "../orca-plugin/src/panel";
import { panelRepo } from "../orca-plugin/src/panel/repo";
import { openDesktop } from "../src/commands/open";
import { fakeCtx } from "./helpers";
import { AGENT_IDS, agentInfo } from "../src/view-model/agents";
import { AGENT_GLYPHS } from "../app/src/ds/agent-glyphs";
import { agentStyle, icon } from "../orca-plugin/src/panel/icons";
import { boardStyle } from "../orca-plugin/src/panel/board";
import { style } from "../orca-plugin/src/panel/style";
import { clock } from "../src/view-model/format";

const snapshot = () => structuredClone(fixture) as unknown as ClientSnapshot;
const populated = fixture.repos[0];
const empty: RepoRef = {key:"github.com/acme/empty",label:"acme/empty",path:"/tmp/fixture/empty"};
const render = (s: ClientSnapshot, repo: RepoRef | null) => renderStatusPage(s, {nowS:s.at,reachable:true,transport:"api",repo});
const scopeHtml = (html: string, all: boolean) => html.split(`<div id="${all?"all-repos":"this-repo"}"`)[1]!.split(all?'<div id="this-repo"':'<footer>')[0]!;
for (const repo of [populated, empty]) test(`panel board follows selectors for ${repo.label}`, () => {
 const s=snapshot(), html=render(s,repo), local=scopeHtml(html,false), all=scopeHtml(html,true), scope={repo:repo.key};
 for (const [body,filter] of [[local,scope],[all,{repo:null}]] as const) {
  expect([...body.matchAll(/<h2>(.*?)<\/h2>/g)].map(m=>m[1])).toEqual(["Needs you","Running","Capacity","Done today"]);
  for (const [title,n] of [["Needs you",needsYou(s,filter).length],["Running",running(s,filter).length],["Capacity",capacity(s).length],["Done today",doneToday(s,filter).length]]) expect(body).toContain(`<h2>${title}</h2><span class="pill">${n}</span>`);
  expect(body).toContain(`${counts(s)!.ready} ready`);
  for (const item of needsYou(s,filter)) expect(body).toContain(item.title);
  for (const t of running(s,filter)) expect(body).toContain(t.progress?phaseWords(t.progress.phase):taskStatus(t).label);
 }
 expect(local).toContain(`+${otherReposNeedingYou(s,scope)} in other repos`);
 expect(all).not.toContain("in other repos");
 expect(local).not.toContain("Split the settings page into sections");
 expect(html).toContain(`This repo · ${repo.label}</a>`);
 expect(local).toContain('<a href="#this-repo" aria-current="true">');
 expect(all).toContain('<a href="#all-repos" aria-current="true">All repos</a>');
 expect(html).toContain('.scope-all{display:none}');
 expect(html).toContain('.scope-all:target~.scope-here{display:none}');
 expect(html).not.toMatch(/<script\b|\son[a-z]+\s*=/i);
 expect(html).not.toMatch(/<(button|form|input|select|textarea)\b/i);
 expect(html).toContain("script-src 'none'");
 expect(html).toContain("connect-src 'none'");
 expect(html).toContain("Open pacer");expect(html).toContain("<code>pacer open</code>");
 if(repo===empty) {expect(local).toContain("Nothing running here.");expect(local).toContain("Nothing done here today.");expect(local).toContain("buildbox is not answering");}
});
test("panel embeds the generated tokens, escapes data, and renders selectable commands", async()=>{
 const s=snapshot();s.attention![1].title='<img src=x onerror="bad">';
 const html=render(s,populated);
 expect(html).toContain(await Bun.file("app/src/ds/tokens.css").text());
 expect(html).toContain('&lt;img src=x onerror=&quot;bad&quot;&gt;');
 expect(html).not.toContain('<img');
 expect(html).toContain('pacer retry &#39;t-0409&#39;');
 expect(html).toContain('pacer open &#39;review/t-0412&#39;');
 expect(html).toMatch(/user-select:\s*text/);
});
test("unknown worktree does not accidentally choose the first repo",()=>{
 const html=scopeHtml(render(snapshot(),null),false);
 expect(html).not.toContain("Add SSH keepalive to remote runs");
 expect(html).toContain("+3 in other repos");
});
test("panel resolves a linked active worktree to its owning repo",async()=>{
 const calls:string[][]=[];
 const repo=await panelRepo(snapshot(),async argv=>{
  calls.push(argv);
  return {code:0,stderr:"",stdout:argv[0]==="orca"?JSON.stringify({ok:true,result:{worktree:{id:"repo::/tmp/elsewhere/feature"}}}):"/tmp/fixture/api/.git\n"};
 });
 expect(repo).toEqual(populated);
 expect(calls[0]).toEqual(["orca","worktree","show","--worktree","active","--json"]);
 expect(calls[1]).toContain("/tmp/elsewhere/feature");
 expect(await panelRepo(snapshot(),async()=>({code:1,stdout:"",stderr:"offline"}))).toBeNull();
});
test("active repo without tasks retains its own scope",async()=>{
 const repo=await panelRepo(snapshot(),async()=>({code:0,stderr:"",stdout:JSON.stringify({ok:true,result:{repo:{path:empty.path},worktree:{path:empty.path}}})}));
 expect(repo).toEqual({...empty,key:empty.path,label:"empty"});
});
test("desktop open uses the registered app and reports missing handlers for fallback",async()=>{
 const calls:string[][]=[];
 const ctx=fakeCtx({run:async argv=>{calls.push(argv);return {code:0,stdout:"",stderr:""};}});
 expect(await openDesktop(ctx,"review/t-0412","darwin")).toBe(true);
 expect(calls[0]).toEqual(["open","-b","dev.pacer.desktop","pacer://review/t-0412"]);
 expect(await openDesktop(fakeCtx(),"overview","darwin")).toBe(false);
});
test("open path falls back to the browser and bypasses desktop for --browser and --print",async()=>{
 const {spyOn}=await import("bun:test"), {openCmd}=await import("../src/commands/open");
 const fetchSpy=spyOn(globalThis,"fetch").mockImplementation((async()=>Response.json({ok:true},{headers:{"x-pacer":"1"}})) as unknown as typeof fetch);
 try {
  const calls:string[][]=[], urls:string[]=[];
  const ctx=fakeCtx({which:()=>null,run:async argv=>{calls.push(argv);return {code:1,stdout:"",stderr:"not installed"};}});
  const deps={opener:async(url:string)=>{urls.push(url);}};
  expect((await openCmd(["review/t-0412"],ctx,deps)).code).toBe(0);
  expect(new URL(urls[0]).hash).toBe("#/review/t-0412");
  expect(calls).toHaveLength(1);
  expect((await openCmd(["--browser"],ctx,deps)).code).toBe(0);
  expect((await openCmd(["--print"],ctx,deps)).out).toContain("/app/auth?code=");
  expect(calls).toHaveLength(1);
 } finally {fetchSpy.mockRestore();}
});
test("plugin Open pacer command reuses the open path",async()=>{
 const {createPlugin}=await import("../orca-plugin/src/plugin");
 let opened=0;const commands=new Map<string,(args?:unknown)=>unknown>();
 const plugin=createPlugin({open:async()=>{opened++;},home:"/tmp/fixture",pluginRoot:"/tmp/fixture/plugin",nowS:()=>0,timers:{every:()=>()=>{},after:()=>()=>{}},http:{get:async()=>({status:503,body:""}),stream:()=>()=>{}},fs:{readText:()=>null,exists:()=>false,writeTextAtomic:()=>{}}});
 await plugin.activate({commands:{register:(id,handler)=>commands.set(id,handler)},events:{on:()=>{}},host:{call:async()=>{throw new Error("No host IPC needed");}},grantedCapabilities:[],log:()=>{}});
 try {expect(await commands.get("open")!()).toEqual({ok:true});expect(opened).toBe(1);} finally {await plugin.deactivate();}
});

test("scope is two adjacent full-height pill links with the selected segment filled",()=>{
 const html=render(snapshot(),populated);
 for(const all of [false,true]) {
  const nav=scopeHtml(html,all).match(/<nav class="scope-toggle"[^>]*>(.*?)<\/nav>/)![1]!;
  expect(nav).toBe(`<a href="#this-repo"${all?"":' aria-current="true"'}>This repo · ${populated.label}</a><a href="#all-repos"${all?' aria-current="true"':""}>All repos</a>`);
 }
 expect(boardStyle).toContain('.scope-toggle{display:flex;align-items:stretch;');
 expect(boardStyle).toContain('min-height:32px');
 expect(boardStyle).toContain('border-radius:999px');
 expect(boardStyle).toContain('.scope-toggle a[aria-current]{background:var(--ink);border-color:var(--ink);color:var(--ink-on-ink)}');
});
test("executor marks reuse every app glyph, brand colour, alias and account identity",()=>{
 for(const id of AGENT_IDS) {
  const info=agentInfo(id), glyph=AGENT_GLYPHS[info.glyph!], html=icon(`${id}#team@devbox`,24);
  expect(html).toContain(`viewBox="${glyph.viewBox}"`);
  expect(html).toContain(`d="${glyph.path}"`);
  expect(html).not.toContain('class="monogram"');
  if(glyph.evenOdd) expect(html).toContain('fill-rule="evenodd"');
  expect(agentStyle).toContain(`--agent-color:${info.color==="ink"?"var(--ink)":info.color}`);
 }
 expect(icon("claude")).toBe(icon("claude-code"));
 expect(icon("antigravity")).toBe(icon("agy"));
 expect(icon("opencode#byteplus@buildbox")).toBe(icon("byteplus"));
 expect(icon("opencode",24,"local")).toBe(icon("local",24));
 expect(icon("custom-runner")).toContain('class="monogram">CU');
 const s=snapshot(), html=render(s,populated);
 for(const e of capacity(s)) expect(html).toContain(icon(e.agent,24,e.account));
 expect(html).not.toContain('>Cx<');
});
test("done rows show success or failure, executor mark and right-aligned time",()=>{
 const s=snapshot(), base=s.tasks.find(t=>t.state==="done")!;
 s.tasks=[
  {...base,id:"done",goal:"Finished task",state:"done",review:undefined,updatedAt:s.at},
  {...base,id:"accepted",goal:"Accepted task",state:"done",review:{accepted:true,kind:null,note:null,at:s.at},updatedAt:s.at},
  {...base,id:"failed",goal:"Failed task",state:"failed",review:undefined,updatedAt:s.at},
  {...base,id:"rejected",goal:"Rejected task",state:"done",review:{accepted:false,kind:null,note:null,at:s.at},updatedAt:s.at},
 ];
 const html=scopeHtml(render(s,populated),true);
 expect(doneToday(s,{repo:null})).toHaveLength(4);
 for(const t of doneToday(s,{repo:null})) {
  const status=taskStatus(t), row=[...html.matchAll(/<div class="row done [^"]+">(.*?)<\/div>/g)].map(m=>m[1]!).find(part=>part.startsWith(`<span title="${status.label}"`) && part.includes(t.goal));
  expect(row).toBeDefined();
  const content=row!.split('</div>')[0]!;
  expect(content).toContain(`aria-label="${status.label}">${status.tone==="good"?"✓":status.tone==="bad"?"✗":"·"}</span>`);
  expect(content).toContain(icon(t.executor!,16));
  expect(content).toEndWith(`<small class="done-time">${clock(t.updatedAt,s.at)}</small>`);
 }
 expect(boardStyle).toContain('.good{color:var(--good-fg)}');
 expect(boardStyle).toContain('.bad{color:var(--bad-fg)}');
 expect(boardStyle).toContain('.done-time{flex:none;text-align:right}');
});
test("actions, planner and footer have labelled blocks and separate selectable commands",()=>{
 const html=render(snapshot(),populated);
 expect(html).toContain('<span class="bad" aria-label="Failed">✗</span>');
 expect(html).toMatch(/<div class="row actions"><span class="action-block action-primary">[^<]+<\/span><span class="action-block action-secondary">[^<]+<\/span><\/div><div class="stack action-commands"><code>/);
 expect(html).toContain('63% · pace 77 · resets Mon</span>');
 expect(html).toContain('<div class="action-block action-primary"><strong>Delegate from this worktree</strong><code>pacer delegate --repo');
 expect(html).toContain('<div class="action-block action-secondary"><strong>Open pacer</strong>');
 expect(html).toContain('desktop first');
});
test("panel colour declarations use tokens with system dark tokens embedded",async()=>{
 const tokens=await Bun.file("app/src/ds/tokens.css").text();
 expect(tokens).toContain('@media (prefers-color-scheme: dark)');
 // Brand constants are token declarations sourced from agentInfo; all painted colours reference tokens.
 for(const css of [style,boardStyle.replace(tokens,"")]) {
  for(const declaration of css.matchAll(/(?:^|[;{])\s*((?:background|color|border(?:-color)?|fill|stroke|outline)(?:\s*):[^;}]+)/g)) {
   expect(declaration[1]).toMatch(/var\(--|currentColor|inherit/);
   expect(declaration[1]).not.toMatch(/#[a-f0-9]{3,8}\b|rgba?\(/i);
  }
 }
});
