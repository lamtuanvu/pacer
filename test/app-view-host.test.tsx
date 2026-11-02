import { expect, test } from 'bun:test';
import { h } from 'preact';
import render from 'preact-render-to-string';
import { activateView, ViewVisibility } from '../app/src/workspace/view-host';
import { createActionRunner } from '../app/src/data/actions';
import { AppFrame } from '../app/src/shell/AppFrame';
test('detail host retains five most recently activated views and excludes non-detail screens', () => {
 let views: {key:string;route:string}[]=[];
 for(const key of ['a','b','c','d','e','a','f']) views=activateView(views,key,key);
 expect(views.map(v=>v.key)).toEqual(['c','d','e','a','f']);
 expect(activateView(views,null,'tasks')).toBe(views);
});
test('inactive view is hidden and inert, active view is accessible', () => {
 expect(render(<ViewVisibility active={false}>draft</ViewVisibility>)).toContain('hidden');
 expect(render(<ViewVisibility active={false}>draft</ViewVisibility>)).toContain('inert');
 expect(render(<ViewVisibility active>draft</ViewVisibility>)).not.toContain('inert');
});
test('disconnect keeps drafts editable without fieldsets', () => {
 const html=render(<AppFrame main={<textarea>draft</textarea>} live="Reconnecting…" dock={<textarea/>} overlay={<textarea/>}/>);
 expect(html).not.toContain('<fieldset'); expect(html).toContain('aria-live="polite"');
});
test('disconnected action runner blocks service actions but keeps navigation available', async () => {
 let calls=0, navigated='';
 const runner=createActionRunner({connected:()=>false,call:async<T,>()=>{calls++;return undefined as T;},refetch:()=>{},waitFor:async()=>true,navigate:hash=>{navigated=hash;}});
 expect((await runner.run('send',{label:'Send',op:'msg.send',params:{}})).status).toBe('error'); expect(calls).toBe(0);
 await runner.run('open',{label:'Open',op:'ui.open',params:{view:'task',id:'a'}}); expect(navigated).toContain('a');
});
import { capturePosition, restorePosition } from '../app/src/workspace/position';
test('scroll and stable focus restore separately for every container', () => {
 const a={scrollTop:42,scrollLeft:7},b={scrollTop:8,scrollLeft:0}; let focused='';
 const saved=capturePosition([['page',a],['files',b]],'answer'); a.scrollTop=0;b.scrollTop=0;
 restorePosition(saved,[['page',a],['files',b]],id=>{focused=id;});
 expect([a.scrollTop,a.scrollLeft,b.scrollTop,focused]).toEqual([42,7,8,'answer']);
});
import { chromium } from 'playwright-core';
const browserPath = process.env.PACER_TEST_BROWSER;
test.skipIf(!browserPath)('mounted views restore draft, scroll and focus, pause reads, and evict LRU', async () => {
 const build = await Bun.build({ entrypoints: ['test/fixtures/app-view-host-browser.tsx'], target: 'browser' });
 expect(build.success).toBe(true);
 const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
 try {
  const page = await browser.newPage();
  await page.route('http://pacer.test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="app"></div>' }));
  await page.goto('http://pacer.test');
  await page.evaluate(async source => { await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))); }, await build.outputs[0]!.text());
  await page.locator('#draft-a').fill('saved draft');
  await page.locator('#card-a summary').click();
  await page.locator('#draft-a').focus();
  await page.locator('#scroll-a').evaluate(node => { node.scrollTop = 170; node.dispatchEvent(new Event('scroll')); });
  const go = async (id: string) => { await page.evaluate(id => (window as any).viewFixture.navigate(id), id); await page.waitForFunction(id => document.querySelector(`#draft-${id}`)?.closest('.pc-view')?.hasAttribute('hidden') === false, id); };
  await go('b');
  expect(await page.locator('#draft-a').evaluate(node => node.closest('.pc-view')?.hasAttribute('inert'))).toBe(true);
  const before = await page.evaluate(() => (window as any).viewFixture.calls.filter((id:string) => id === 'a').length);
  await page.evaluate(() => (window as any).viewFixture.revise()); await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).viewFixture.calls.filter((id:string) => id === 'a').length)).toBe(before);
  await go('a');
  expect(await page.locator('#draft-a').inputValue()).toBe('saved draft');
  expect(await page.locator('#scroll-a').evaluate(node => node.scrollTop)).toBe(170);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('draft-a');
  for (const id of ['c','d','e','f','g']) await go(id);
  expect(await page.locator('.pc-view').count()).toBe(5);
  expect(await page.evaluate(() => (window as any).viewFixture.unmounted)).toContain('a');
  await go('a');
  expect(await page.locator('#draft-a').inputValue()).toBe('saved draft');
  expect(await page.locator('#scroll-a').evaluate(node => node.scrollTop)).toBe(170);
  expect(await page.locator('.pc-view:not([hidden])').innerText()).toContain('cached content');
  expect(await page.locator('#card-a').evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
 } finally { await browser.close(); }
}, 20000);
import { TopBar } from '../app/src/shell/TopBar';
test.skipIf(!browserPath)('connection status stays visible in the top bar when the offline banner is present', async () => {
 const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
 try {
  const page = await browser.newPage();
  const build=await Bun.build({entrypoints:['test/fixtures/app-view-host-status.tsx'],target:'browser'});
  expect(build.success).toBe(true);
  await page.setContent('<div id="app"></div>');
  await page.addStyleTag({ content: await Bun.file('app/src/styles.css').text() });
  await page.evaluate(async source=>{await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));},await build.outputs[0]!.text());
  expect(await page.locator('.pc-topbar .pc-live').count()).toBe(0);
  await page.locator('.pc-topbar .pc-live').waitFor({state:'visible',timeout:4000});
  expect(await page.locator('.pc-topbar .pc-live').getAttribute('aria-live')).toBe('off');
 } finally { await browser.close(); }
}, 20000);
import { WorkspaceIdentity, WorkspaceScope, useWorkspaceKey, useWorkspaceState } from '../app/src/workspace/state';
import { workspaceKey, workspaceManager } from '../app/src/workspace/manager';
test('named sections stay independent inside a route scope', () => {
 function Probe(){const a=useWorkspaceKey(undefined,'assistant'),b=useWorkspaceKey(undefined,'delegate');expect(a).not.toBe(b);expect(a).toBe(workspaceKey('service',undefined,'assistant'));return null;}
 render(<WorkspaceIdentity.Provider value="service"><WorkspaceScope.Provider value={workspaceKey('service','task','workspace')}><Probe/></WorkspaceScope.Provider></WorkspaceIdentity.Provider>);
 expect(workspaceKey('service','task','workspace')).not.toBe(workspaceKey('service','task','trace'));
});
test('hidden host retains its terminal child until eviction', () => {
 let rendered=0;function Terminal(){rendered++;return <span>terminal attached</span>;}
 expect(render(<ViewVisibility active={false}><Terminal/></ViewVisibility>)).toContain('terminal attached');expect(rendered).toBe(1);

});
test('work response draft clears only in the successful action callback', async () => {
 const source=await Bun.file('app/src/screens/work/WorkView.tsx').text();expect(source).toContain('draft:work-response');expect(source).toContain("setResponse('');onChanged();");
});
import { ThreadView } from '../app/src/screens/session/Thread';
import { SessionPanel } from '../app/src/screens/session/SessionPanel';
test('kept-alive copies of the same task have unique label and tab ids', () => {
 const composer={value:'',busy:false,onInput:()=>{},onSend:()=>{},onAnswer:()=>{}};
 const child=<><ThreadView id="same" composer={composer} announcement=""/><SessionPanel id="same" tab="changes" changes="changes" details="details" onTab={()=>{}}/></>;
 const html=render(<><ViewVisibility active={false}>{child}</ViewVisibility><ViewVisibility active>{child}</ViewVisibility></>);
 const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);expect(new Set(ids).size).toBe(ids.length);
 for(const match of html.matchAll(/(?:for|aria-labelledby)="([^"]+)"/g))expect(ids).toContain(match[1]);
});
import { options } from 'preact';
import { WorkNode } from '../app/src/screens/work/WorkView';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { ActionContext } from '../app/src/data/action-context';
test('successful retry deletes its persisted work response; failed retry keeps it', async () => {
 const key=workspaceKey('response-service','node','trace'),scope=workspaceKey('response-service','view','trace');
 const node={taskId:'node',parentId:null,rootId:'node',title:'Retry this task',state:'failed',rev:3,review:{accepted:false},dependencies:[],waivedChildren:[],attempts:[],decisions:[],retryEligibility:{allowed:true}} as any;
 let fail=true,changed=0,click:undefined|(()=>void);
 const runner=createActionRunner({connected:()=>true,call:async<T,>()=>{if(fail)throw Error('failed');return {} as T;},refetch:()=>{},waitFor:async()=>true,navigate:()=>{}});
 const mount=()=>{const previous=options.vnode;options.vnode=vnode=>{previous?.(vnode);if(vnode.type==='button'&&vnode.props.children==='Retry work')click=(vnode.props as any).onClick as ()=>void;};try{render(<ActionContext.Provider value={runner}><TaskContext.Provider value={{api:{} as any,state:{...initialState(),connected:true}}}><WorkspaceIdentity.Provider value="response-service"><WorkspaceScope.Provider value={scope}><WorkNode node={node} nodes={[]} onChanged={()=>changed++}/></WorkspaceScope.Provider></WorkspaceIdentity.Provider></TaskContext.Provider></ActionContext.Provider>);}finally{options.vnode=previous;}};
 workspaceManager.set(key,'expandedCard',true);workspaceManager.set(key,'draft:work-response','feedback');mount();expect(click).toBeDefined();click!();await Bun.sleep(0);expect(workspaceManager.get(key,'draft:work-response','')).toBe('feedback');expect(changed).toBe(0);
 fail=false;mount();click!();await Bun.sleep(0);expect(workspaceManager.get(key,'draft:work-response','')).toBe('');expect(changed).toBe(1);workspaceManager.clearIdentity('response-service');
});
import { Tooltip } from '../app/src/ds/Tooltip';
test('independent portal roots cannot reuse tooltip ids', () => {
 const first=render(<Tooltip text="one"><span>one</span></Tooltip>),second=render(<Tooltip text="two"><span>two</span></Tooltip>);
 expect(/role="tooltip" id="([^"]+)"/.exec(first)?.[1]).not.toBe(/role="tooltip" id="([^"]+)"/.exec(second)?.[1]);
});
test('closed thread remains disabled while offline, open drafts remain editable', () => {
 const composer={value:'draft',busy:false,onInput:()=>{},onSend:()=>{},onAnswer:()=>{},disabledReason:'Reconnecting…',inputDisabled:true};
 const closed=render(<ThreadView id="closed" composer={composer} announcement=""/>),open=render(<ThreadView id="open" composer={{...composer,inputDisabled:false}} announcement=""/>);
 expect(closed).toMatch(/<textarea[^>]*disabled/);expect(open).not.toMatch(/<textarea[^>]*disabled/);
});
import { useTaskContext } from '../app/src/screens/task-shared';
test('service calls share one cache identity and offline mutations use the runner', async () => {
 let calls=0;const api={call:async<T,>()=>{calls++;return {} as T;}} as any,clients:any[]=[];
 const runner=createActionRunner({connected:()=>false,call:api.call,refetch:()=>{},waitFor:async()=>true,navigate:()=>{}});
 function Probe(){clients.push(useTaskContext().api);return null;}
 render(<TaskContext.Provider value={{api,state:initialState()}}><ActionContext.Provider value={runner}><Probe/><Probe/></ActionContext.Provider></TaskContext.Provider>);
 expect(clients[0]).toBe(clients[1]);await expect(clients[0].call('config.set',{})).rejects.toThrow('Reconnecting');expect(calls).toBe(0);await clients[0].call('config.get',{});expect(calls).toBe(1);
});
import { useOperation } from '../app/src/screens/settings/shared';
test('offline settings availability does not mark local drafts as a pending operation', () => {
 const runner=createActionRunner({connected:()=>false,call:async<T,>()=>({} as T),refetch:()=>{},waitFor:async()=>true,navigate:()=>{}});
 function Probe(){const action=useOperation();expect(action.busy).toBe(false);expect(action.unavailable).toContain('Reconnecting');return null;}
 render(<TaskContext.Provider value={{api:{} as any,state:initialState()}}><ActionContext.Provider value={runner}><Probe/></ActionContext.Provider></TaskContext.Provider>);
});

import { takeoverSession } from '../app/src/screens/session/takeover';
test('in-place takeover uses the action runner once without changing the trace or workspace route', async () => {
 for(const original of ['#/tasks/task', '#/workspace?task=task']) {
  let route=original,ready=0;const calls:string[]=[];
  const runner=createActionRunner({connected:()=>true,call:async<T,>(op:string)=>{calls.push(op);return (op==='task.takeover'?{state:'starting'}:{live:true,host:'builtin'}) as T;},refetch:()=>{},waitFor:async()=>true,navigate:hash=>{route=hash;}});
  await takeoverSession({id:'task',call:runner.call.bind(runner),sleep:async()=>{},starting:()=>{},ready:()=>{ready++;}});
  expect(calls).toEqual(['task.takeover','task.session']);expect(ready).toBe(1);expect(route).toBe(original);
 }
});

test.skipIf(!browserPath)('hidden LazyTerminal stays mounted and log eviction frees text while retaining drafts and follow mode', async () => {
 const build=await Bun.build({entrypoints:['test/fixtures/app-view-lifecycle.tsx'],target:'browser',plugins:[{name:'terminal-lifecycle',setup(builder){
  builder.onResolve({filter:/^\.\/term$/},()=>({path:'term',namespace:'terminal-lifecycle'}));
  builder.onLoad({filter:/.*/,namespace:'terminal-lifecycle'},()=>({loader:'tsx',contents:`import {h} from 'preact';import {useEffect} from 'preact/hooks';export function TerminalView(){useEffect(()=>{window.terminalMounted=(window.terminalMounted??0)+1;return()=>{window.terminalUnmounted=(window.terminalUnmounted??0)+1;};},[]);return h('span',{},'attached terminal');}`}));
 }}]});expect(build.success).toBe(true);
 const browser=await chromium.launch({executablePath:browserPath!,headless:true});
 try {
  const page=await browser.newPage();await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));await page.goto('http://pacer.test');
  await page.addScriptTag({type:'module',content:await build.outputs[0]!.text()});
  await page.waitForFunction(()=>(window as any).terminalMounted===1&&(window as any).lifecycleFixture.snapshot().text==='log text');
  await page.evaluate(()=>(window as any).lifecycleFixture.hide());await page.waitForTimeout(150);
  expect(await page.evaluate(()=>(window as any).terminalUnmounted??0)).toBe(0);expect(await page.evaluate(()=>(window as any).lifecycleFixture.snapshot().text)).toBe('log text');
  await page.evaluate(()=>(window as any).lifecycleFixture.evict());await page.waitForFunction(()=>(window as any).terminalUnmounted===1);await page.waitForTimeout(150);
  expect(await page.evaluate(()=>(window as any).lifecycleFixture.snapshot())).toEqual({text:'',draft:'keep draft',follow:false});
 }finally{await browser.close();}
},20000);
