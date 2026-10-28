import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const browserPath = process.env.PACER_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTest = test.skipIf(!existsSync(browserPath));

browserTest("activity runtime confirms before sending, refreshes, keeps stale documents and handles service events", async () => {
  const fixtures = new URL("../.work/fixtures/", import.meta.url).pathname;
  mkdirSync(fixtures, { recursive: true });
  const dir = mkdtempSync(join(fixtures, "plugin-app-"));
  const path = (file: string) => JSON.stringify(new URL(`../${file}`, import.meta.url).pathname);
  const entry = join(dir, "entry.tsx");
  writeFileSync(entry, `
/** @jsxImportSource preact */
import {render} from "preact";
import {useState} from "preact/hooks";
import {Activity} from ${path('app/src/plugins/Activity.tsx')};
import {Rail} from ${path('app/src/shell/Rail.tsx')};
import {TaskContext} from ${path('app/src/screens/task-shared.tsx')};
import {PluginContext,usePluginCatalog} from ${path('app/src/plugins/catalog.ts')};
import {initialState} from ${path('app/src/data/store.ts')};
const log=window.calls=[];
let renders=0;
const api={call:async(op,params)=>{
 log.push({op,params});
 if(op==='plugin.ui.list') {if(window.failList)throw Error('unavailable');return {surfaces:[{plugin:'fx-ui',id:'checklist',surface:'activity',title:'Release checklist',icon:'check-square',visible:!window.hidden}]};}
 if(op==='plugin.list')return {plugins:[{id:'fx-ui',version:'1.0.0',publisher:'pacer-conformance'}]};
 if(op==='plugin.ui.render') {if(window.failRender)throw {code:'plugin_timeout'};return {document:{type:'stack',gap:'content',children:[{type:'text',text:'render '+ ++renders},{type:'button',label:'Confirm me',action:'confirm',variant:'secondary',confirm:{title:'Proceed?',body:'<b>quoted</b>'}},{type:'button',label:'Delete',action:'delete',variant:'danger'},{type:'checkbox',label:'Ready',name:'ready',checked:false,action:'toggle'}]}};}
 if(op==='plugin.ui.action'){await new Promise(resolve=>setTimeout(resolve,100));return {result:'refresh',message:'Plugin says <b>done</b>'};}
}};
function App(){const [signal,setSignal]=useState(0);window.emit=()=>setSignal(n=>n+1);const catalog=usePluginCatalog(api,true,signal);return <TaskContext.Provider value={{api,state:initialState()}}><PluginContext.Provider value={catalog}><Rail route={{name:'plugin',plugin:'fx-ui',id:'checklist',query:{repo:null,scope:null}}} counts={null}/><Activity plugin="fx-ui" id="checklist"/></PluginContext.Provider></TaskContext.Provider>;}
render(<App/>,document.getElementById('app'));
`);
  const build = await Bun.build({ entrypoints: [entry], target: "browser", tsconfig: new URL("../app/tsconfig.json", import.meta.url).pathname });
  expect(build.success).toBe(true);
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const server = Bun.serve({ port: 0, fetch: () => new Response('<div id="app"></div>', { headers: { 'content-type': 'text/html' } }) });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); console.error('plugin browser:', error.message); });
    await page.addScriptTag({ type: "module", content: await build.outputs[0]!.text() });
    await page.getByText('render 1', { exact: true }).waitFor();
    await page.getByText('Added by the plugin fx-ui 1.0.0 from pacer-conformance').waitFor();
    const sent = () => page.evaluate(() => (window as any).calls.filter((c: any) => c.op === 'plugin.ui.action'));
    await page.getByRole('button', { name: 'Confirm me', exact: true }).click();
    await page.getByRole('dialog', { name: 'fx-ui asks: Proceed?' }).waitFor();
    expect(await page.locator('.pc-dialog-message').textContent()).toBe('“<b>quoted</b>”');
    expect(await sent()).toHaveLength(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await sent()).toHaveLength(0);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog', { name: 'fx-ui asks to Delete' }).waitFor();
    expect(await sent()).toHaveLength(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Working…', { exact: true }).first().waitFor();
    expect(await page.getByRole('checkbox').getAttribute('aria-disabled')).toBe('true');
    await page.getByText('render 2', { exact: true }).waitFor();
    expect(await page.getByRole('status').last().textContent()).toBe('Plugin says <b>done</b>');
    const actions = await sent();
    expect(actions).toHaveLength(1); expect(actions[0].params.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(actions[0].params.context).toEqual({ route: 'start', theme: 'light' });
    await page.getByRole('checkbox').click();
    await page.getByText('render 3', { exact: true }).waitFor();
    expect((await sent())[1].params.values).toEqual({ ready: true });
    await page.evaluate(() => { (window as any).failRender = true; (window as any).emit('plugin', { id: 'fx-ui' }); });
    await page.getByText('Out of date', { exact: true }).waitFor();
    expect(await page.getByText('render 3', { exact: true }).count()).toBe(1);
    await page.getByText("This plugin didn't answer in time.").waitFor();
    await page.evaluate(() => { (window as any).failRender = false; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByText('render 4', { exact: true }).waitFor();
    expect(await page.getByText('Out of date', { exact: true }).count()).toBe(0);
    await page.evaluate(() => { (window as any).failList = true; (window as any).emit('config', { area: 'plugins' }); });
    await page.waitForFunction(() => !document.querySelector('[aria-label="Release checklist (plugin)"]'));
    expect(await page.getByRole('link', { name: 'Add a plugin', exact: true }).count()).toBe(1);
    await page.evaluate(() => { (window as any).failList = false; (window as any).emit('plugin', { id: 'fx-ui' }); });
    await page.getByRole('link', { name: 'Release checklist (plugin)', exact: true }).waitFor();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForFunction(() => (window as any).calls.some((c: any) => c.op === 'plugin.ui.render' && c.params.context.theme === 'dark'));
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 30000);
