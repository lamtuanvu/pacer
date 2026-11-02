import { expect, test } from 'bun:test';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { createQueryCache, queryCacheFor } from '../app/src/data/query';
import { initialState } from '../app/src/data/store';
import { TaskContext, useQuery, queryRevision } from '../app/src/screens/task-shared';
import type { BrowserApi } from '../app/src/data/api';
import { resolveRouteBeforeRender } from '../app/src/router';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
test('cached hook data is available on the first render with updating feedback', async () => {
  const api = { call: async () => ({ title: 'cached task' }) } as unknown as BrowserApi;
  const query = queryCacheFor(api, api.call).createQuery(() => {});
  query.update('task.get', JSON.stringify({ id: 'one' }), '');
  await settle(); query.dispose();
  function View() { const result = useQuery<{title:string}>('task.get', {id:'one'}); return h('p', {}, `${result.data?.title}:${result.updating}`); }
  const html = renderToString(h(TaskContext.Provider, {value:{api,state:initialState()}}, h(View, {})));
  expect(html).toContain('cached task:true');
});
test('cache peek retains stale data without fetching', async () => {
  let calls = 0;
  const cache = createQueryCache(async () => ++calls);
  const query = cache.createQuery(() => {}); query.update('task.get', '{}', '');
  await settle(); cache.invalidate();
  expect(cache.peek('task.get', '{}')?.data).toBe(1);
  expect(calls).toBe(1); query.dispose();
});
test('task detail revisions ignore activity and unrelated configuration', () => {
  const state = initialState();
  const before = queryRevision(state, 'task.get', {id:'one'});
  expect(queryRevision({...state, activity:[{taskId:'one'} as never], invalidations:{notifications:1}}, 'task.get', {id:'one'})).toBe(before);
  expect(queryRevision({...state, invalidations:{'msg:one':1}}, 'task.get', {id:'one'})).not.toBe(before);
});
test('redirect chains resolve synchronously, preserving queries', () => {
  expect(resolveRouteBeforeRender('#/sessions/one/answer', true).route).toMatchObject({name:'sessions',id:'one'});
  expect(resolveRouteBeforeRender('#/overview?repo=example', true)).toMatchObject({hash:'#/?repo=example',route:{name:'dispatch',query:{repo:'example'}}});
});
test('disconnect during a pending read marks it stale without starting an offline follow-up', async () => {
  let calls = 0, resolve!: (value: string) => void;
  const cache = createQueryCache(() => { calls++; return new Promise<string>(done => {resolve=done;}); });
  const query = cache.createQuery(() => {}); query.update('task.get', '{}', 'online');
  cache.invalidate(); resolve('retained'); await settle();
  expect(calls).toBe(1); expect(cache.peek('task.get','{}')?.data).toBe('retained');
  query.update('task.get', '{}', 'reconnected'); expect(calls).toBe(2);
  query.update('task.get', '{}', 'reconnected'); expect(calls).toBe(2);
  query.dispose(); resolve('current'); await settle();
});

test.skipIf(!process.env.PACER_TEST_BROWSER)('mounted cache consumers and lazy modules return synchronously; reconnect reads once', async () => {
  const { chromium } = await import('playwright-core');
  const build = await Bun.build({entrypoints:['test/fixtures/app-cache-first.tsx'],target:'browser',plugins:[{name:'lazy-view-fixture',setup(build){build.onLoad({filter:/\/WorkView\.tsx$/},()=>({contents:'export function WorkView(){return "RESOLVED MODULE"}',loader:'tsx'}));}}]});
  expect(build.success).toBe(true);
  const browser = await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
  try {
    const page = await browser.newPage();
    await page.route('http://pacer.test/**', route=>route.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
    await page.goto('http://pacer.test');
    await page.evaluate(async source=>{await import(URL.createObjectURL(new Blob([source],{type:'text/javascript'})));},await build.outputs[0]!.text());
    await page.waitForFunction(()=>(window as any).cacheFirst.pending.length===1);
    await page.evaluate(()=>(window as any).cacheFirst.pending[0]('CACHED'));
    await page.waitForFunction(()=>document.querySelector('p')?.textContent==='CACHED');
    const first = await page.evaluate(()=>{const f=(window as any).cacheFirst;f.unmount();f.renders.length=0;f.mount();return f.renders[0];});
    expect(first).toEqual({data:'CACHED',updating:true});
    await page.waitForFunction(()=>(window as any).cacheFirst.pending.length===2);
    await page.evaluate(()=>(window as any).cacheFirst.pending[1]('CURRENT'));
    await page.waitForFunction(()=>document.querySelector('p')?.textContent==='CURRENT');
    await page.evaluate(()=>(window as any).cacheFirst.connection(false));
    await page.waitForTimeout(180);expect(await page.evaluate(()=>(window as any).cacheFirst.pending.length)).toBe(2);
    await page.evaluate(()=>(window as any).cacheFirst.connection(true));
    await page.waitForFunction(()=>(window as any).cacheFirst.pending.length===3);
    await page.waitForTimeout(180);expect(await page.evaluate(()=>(window as any).cacheFirst.pending.length)).toBe(3);
    await page.evaluate(()=>{const f=(window as any).cacheFirst;f.pending[2]('RECONNECTED');f.unmount();f.lazy();});
    await page.waitForFunction(()=>document.querySelector('#app')?.textContent==='RESOLVED MODULE');
    expect(await page.evaluate(()=>{const f=(window as any).cacheFirst;f.unmount();f.lazy();return document.querySelector('#app')?.textContent;})).toBe('RESOLVED MODULE');
  } finally {await browser.close();}
}, 30_000);

test('diff and session follow task activity, task.get does not', () => {
  const state = initialState(), next = {...state,activity:[{id:'new',taskId:'one'} as never]};
  for (const op of ['task.diff','task.session']) expect(queryRevision(next,op,{id:'one'})).not.toBe(queryRevision(state,op,{id:'one'}));
  expect(queryRevision(next,'task.get',{id:'one'})).toBe(queryRevision(state,'task.get',{id:'one'}));
});
test('previous task data never crosses ids even with keepPreviousData', async () => {
  const states: any[] = [];
  const query = createQueryCache(async (_op, params) => (params as {id:string}).id === 'one' ? {id:'one'} : new Promise(()=>{})).createQuery(state=>states.push(state),true);
  query.update('task.get',JSON.stringify({id:'one'}),''); await settle();
  query.update('task.get',JSON.stringify({id:'two'}),'');
  expect(states.at(-1).data).toBeUndefined(); query.dispose();
});
