import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {renderPanel} from '../orca-plugin/src/panel';
import {validateStrategy} from '../src/config/strategy';
import {decodeCmdLine,emptySnapshot,type CmdData} from '../src/link/envelope';
const strategyConfig=validateStrategy({accounts:{personal:{kind:'claude'},team:{kind:'codex',orca_account:'team-id'},spare:{kind:'endpoint',usage:'unmetered',model:'local/test'}},planner:'claude-code',runners:{'opencode#spare':{}},pacing:{policy:'even',order:['codex#team','opencode#spare'],planner_reserve:25,accounts:'fill',fill_threshold:95},routing:[{default:['codex#team','opencode#spare']}]},'fixture');
function html(live=true,config=strategyConfig){return renderPanel({...emptySnapshot(),at:100,console:live?{handle:'console',paneKey:null,pid:1,heartbeatAt:100,startedAt:1}:null,strategies:['default','other']},{nowS:100,transport:'http',reachable:true,strategyConfig:config,updateCheck:false} as any);}
function settings(markup=html()){return markup.match(/<main[^>]*data-page="settings"[^>]*>([\s\S]*?)<\/main>/)?.[1]??'';}
test('settings renders sections in order and values from the strategy without forms',()=>{
 const page=settings();expect([...page.matchAll(/<h2>(.*?)<\/h2>/g)].map(m=>m[1])).toEqual(['Planner','Accounts','Runners','Executors','Pacing','Strategies','Updates','Plugin']);
 for(const value of ['claude-code','personal','team','orca','opencode#spare','local/test','even','25%','fill','95%'])expect(page).toContain(value);
 expect(page).not.toContain('<form');expect(html()).toContain('aria-label="Settings"');
});
test('settings remains readable without a console and disables all console commands',()=>{
 const page=settings(html(false));expect(page).toContain('Open a pacer console to change settings');expect(page).toContain('data-setup="pacer console"');expect(page).toContain('95%');
 const buttons=[...page.matchAll(/<button\b[^>]*data-command="[^"]+"[^>]*>/g)];expect(buttons.length).toBeGreaterThan(15);for(const [tag] of buttons)expect(tag).toContain('disabled');
});
class Node {dataset:Record<string,string>={};disabled=false;hidden=false;textContent='';innerHTML='';value='';parentElement={className:''};handlers:Record<string,Function>={};addEventListener(k:string,fn:Function){this.handlers[k]=fn;}focus(){}click(){if(!this.disabled)this.handlers.click?.();}}
function browser(markup=html(),session:Record<string,string>={}){
 const ids:Record<string,Node>=new Proxy({}, {get:(obj:any,key:string)=>obj[key]??=new Node()});
 const buttons=[...markup.matchAll(/<button\b([^>]*)>/g)].map(m=>{const n=new Node();for(const [,k,v] of m[1].matchAll(/data-([a-z-]+)="([^"]*)"/g))n.dataset[k.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;n.disabled=/\bdisabled\b/.test(m[1]);n.textContent=m[0];return n;});
 const sent:any[]=[];let now=100000,listener:Function=()=>{};const parent={postMessage:(m:any)=>sent.push(m)};
 runInNewContext(markup.match(/<script>\n([\s\S]*?)<\/script>/)![1],{Date:class extends Date{static now(){return now;}},TextEncoder,TextDecoder,Uint8Array,atob,setInterval:()=>{},sessionStorage:{getItem:(k:string)=>session[k]??null,setItem:(k:string,v:string)=>{session[k]=v;}},document:{getElementById:(id:string)=>id==='pacer-actions'?{textContent:markup.match(/id="pacer-actions">(.*?)<\/script>/s)![1]}:ids[id],querySelectorAll:(s:string)=>{const key=s.match(/^\[data-([a-z-]+)\]$/)?.[1]?.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return key?buttons.filter(n=>key in n.dataset):[];},querySelector:()=>new Node()},window:{parent,addEventListener:(k:string,fn:Function)=>{if(k==='message')listener=fn;}}});
 const reply=(m:any,value:any)=>listener({source:parent,data:{type:'orca-panel-action-result',requestId:m.requestId,ok:true,value}});
 function click(command:CmdData){const data=JSON.parse(markup.match(/id="pacer-actions">(.*?)<\/script>/s)![1]);const raw=data.encoded?JSON.parse(Buffer.from(data.encoded,'base64').toString()):data;const unpack=(v:any):any=>Array.isArray(v)?v.map(unpack):v&&typeof v==='object'?Object.hasOwn(v,'$runs')?v.$runs.map(([c,n]:any)=>c.repeat(n)).join(''):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,unpack(x)])):v;const commands=unpack(raw).commands;const key=Object.keys(commands).find(k=>k.startsWith("s-")&&JSON.stringify(commands[k])===JSON.stringify(command));expect(key).toBeDefined();const b=buttons.find(n=>n.dataset.command===key)!;b.click();return b;}
 function delivered(){const m=sent.at(-1);expect(m.action).toBe('workspace.readContext');reply(m,{branch:'feature',displayName:'Feature',worktreeId:'repo::feature',terminals:[{id:'console'}]});const send=sent.at(-1);expect(send.action).toBe('terminal.sendText');return decodeCmdLine(send.params.text).cmd?.data;}
 return {sent,click,delivered,now:(n:number)=>now=n};
}
for(const command of [
 {cmd:'config-set',key:'planner',value:'codex#team'},
 {cmd:'config-set',key:'pacing.policy',value:'priority'},
 {cmd:'config-set',key:'pacing.planner_reserve',value:'30'},
 {cmd:'config-set',key:'pacing.planner_reserve',value:'20'},
 {cmd:'config-set',key:'pacing.accounts',value:'spread'},
 {cmd:'config-set',key:'pacing.fill_threshold',value:'100'},
 {cmd:'config-set',key:'pacing.fill_threshold',value:'90'},
 {cmd:'config-set',key:'pacing.order',value:'opencode#spare,codex#team'},
 {cmd:'config-set',key:'update_check',value:'true'},
 {cmd:'notify-level',level:'all'}, {cmd:'block',executor:'codex#team'},
 {cmd:'use',strategy:'other'}, {cmd:'check-updates'}, {cmd:'update'},
 {cmd:'open-terminal',command:'account-add'}, {cmd:'open-terminal',command:'account-add-orca'}, {cmd:'open-terminal',command:'runner-add'}, {cmd:'open-terminal',command:'init'},
] as CmdData[])test(`settings sends ${JSON.stringify(command)}`,()=>{const b=browser();b.click(command);const got=b.delivered();expect(got).toEqual(command.cmd==='open-terminal'?{...command,worktreeId:'repo::feature'}:command);});
test('account removal is disabled while a runner uses it',()=>{expect(settings()).toMatch(/data-command="s-account-team"[^>]*disabled/);});
test('runner removal needs a second click within five seconds',()=>{const b=browser();const c:CmdData={cmd:'runner-remove',name:'opencode#spare'};const before=b.sent.length;const button=b.click(c);expect(b.sent).toHaveLength(before);expect(button.textContent).toContain('Confirm');b.now(105001);button.click();expect(b.sent).toHaveLength(before);b.now(110000);button.click();expect(b.delivered()).toEqual(c);});

import {setupChecklist} from '../src/setup/checklist';
import {createPlugin} from '../orca-plugin/src/plugin';
import {ManualTimers,flush} from './plugin-transports.test';
import type {OrcaWorkerContext} from '../orca-plugin/src/orca-api';
test('worker rerenders on strategy and plugin preferences, keeps unchanged panels stable, and only reads configuration',async()=>{
 const timers=new ManualTimers(),writes:string[]=[],reads:string[]=[];let now=100,policy='even',autoConsole=false,notifications='important';const snapshot=emptySnapshot();
 const raw={accounts:{personal:{kind:'claude'}},planner:'claude-code',pacing:{policy}};
 const plugin=createPlugin({home:'/tmp/settings-fixture',pluginRoot:'/tmp/settings-plugin',bootstrap:{checkSetup:async()=>setupChecklist({version:null,planner:null,service:{installed:false,running:false},link:false,live:false,agents:[]},now),stop(){}} as any,nowS:()=>now,timers,http:{get:async()=>({status:401,body:''}),stream:()=>()=>{}},fs:{exists:()=>true,readText:(path)=>{reads.push(path);return path.endsWith('strategy.yaml')?JSON.stringify({...raw,pacing:{policy}}):null;},writeTextAtomic:(_,text)=>writes.push(text)}});
 const ctx={host:{call:async(method:string)=>method==='settings.get'?{settings:{transport:'bridge',autoConsole,notifications}}:method==='storage.get'?{value:snapshot}:method==='workspace.readContext'?{branch:'x',displayName:'X',terminals:[]}:{}},commands:{register(){}},events:{on(){}},log(){}} as unknown as OrcaWorkerContext;
 try {await plugin.activate(ctx);await flush();await timers.advance(200);expect(settings(writes.at(-1))).toContain('Policy: even');const before=writes.length;await timers.advance(15000);expect(writes).toHaveLength(before);
 policy='priority';now=130;await timers.advance(15000);await timers.advance(200);expect(settings(writes.at(-1))).toContain('Policy: priority');
 autoConsole=true;now=160;await timers.advance(30000);await timers.advance(200);expect(settings(writes.at(-1))).toContain('Automatic console: on');
 notifications='all';now=190;await timers.advance(30000);await timers.advance(200);expect(settings(writes.at(-1))).toContain('Notifications: all');
 expect(reads.every(p=>p.endsWith('/token')||p.endsWith('/strategy.yaml')||p.endsWith('/active')||p.endsWith('/check-setup-request.json'))).toBe(true);
 } finally {await plugin.deactivate();}
});

test('different settings changes are independent and completed changes clear pending state after reload',()=>{const session:Record<string,string>={},b=browser(html(),session);b.click({cmd:'config-set',key:'pacing.policy',value:'priority'});b.delivered();expect(Object.keys(session)).toContain('pacer-pending-actions');b.click({cmd:'config-set',key:'pacing.accounts',value:'spread'});expect(b.delivered()).toEqual({cmd:'config-set',key:'pacing.accounts',value:'spread'});const changed={...strategyConfig,pacing:{...strategyConfig.pacing,policy:'priority' as const,accounts:'spread' as const}};browser(html(true,changed),session);expect(JSON.parse(session['pacer-pending-actions']??'{}')).toEqual({});});
test('terminal actions have independent pending state',()=>{const b=browser();b.click({cmd:'open-terminal',command:'account-add'});b.delivered();b.click({cmd:'open-terminal',command:'runner-add'});expect(b.delivered()).toEqual({cmd:'open-terminal',command:'runner-add',worktreeId:'repo::feature'});});

test('selected settings choices are pressed and enabled in the live console',()=>{
 const page=settings();
 for(const id of ['planner-claude-code','pacing.policy-even','pacing.accounts-fill','notify-important']) {
  const tag=page.match(new RegExp(`<button[^>]*data-command="s-${id}"[^>]*>`))?.[0]??'';
  expect(tag).toContain('aria-pressed="true"');expect(tag).not.toContain('disabled');
 }
 expect(page).not.toContain('Use claude-code');
 expect(page).toMatch(/data-command="s-planner-codex#team"[^>]*aria-pressed="false"/);
});
test('every disabled live action has a title and visible reason',()=>{
 const page=settings(html(true,{...strategyConfig,pacing:{...strategyConfig.pacing,plannerReserve:0,fillThreshold:100}}));
 for(const [tag] of page.matchAll(/<button[^>]*disabled[^>]*>/g)) {
  const reason=tag.match(/title="([^"]+)"/)?.[1];expect(reason).toBeDefined();expect(page).toContain(`<small class="muted">${reason}</small>`);
 }
 expect(page).toContain('Planner — can&#39;t remove');expect(page).toContain('In use by codex#team');
});
test('settings explains each policy and hides fill controls under spread',()=>{
 const descriptions={priority:'Use executors in your order; move ahead-of-pace ones later and expiring quota first.',even:'Spread work toward executors with the most pace headroom.', 'burn-before-reset':'Use quota that would reset unused first.', 'cheapest-first':'Prefer unmetered, then quota, then metered.'};
 for(const [policy,description] of Object.entries(descriptions)) expect(settings(html(true,{...strategyConfig,pacing:{...strategyConfig.pacing,policy:policy as any}}))).toContain(description);
 expect(settings()).toContain('Fill one account until it leaves the pace band or reaches the threshold.');
 const page=settings(html(true,{...strategyConfig,pacing:{...strategyConfig.pacing,accounts:'spread'}}));
 expect(page).toContain('Spread across accounts by headroom.');expect(page).not.toContain('Fill threshold');expect(page).not.toContain('s-pacing.fill_threshold');
});
test('offline settings uses only the console banner for disabled explanations',()=>{
 const page=settings(html(false));expect(page.match(/Open a pacer console to change settings/g)).toHaveLength(1);
 expect(page).not.toContain('Planner — can&#39;t remove');expect(page).not.toContain('In use by');
});
