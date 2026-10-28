import { beforeAll, afterAll, expect, test } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { renderToString } from 'preact-render-to-string';
import { PluginsPage } from '../app/src/screens/settings/PluginsPage';
import { PluginSettingsPage, settingsDefaults, dirtyFields, fieldErrors } from '../app/src/screens/settings/PluginSettingsPage';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { hrefFor, resolveRoute, routes, parentFor, titleFor } from '../app/src/router';
import { pluginFixture, surfaceFixtures, settingsFixture } from './fixtures/ui/plugin-settings-data';
import { createApi } from '../app/src/data/api';
const query={repo:null,scope:null}, plugins={plugins:[pluginFixture]}, surfaces={surfaces:surfaceFixtures};
const draw=(child:any)=>renderToString(<TaskContext.Provider value={{api:{call:async()=>({})} as any,state:initialState()}}>{child}</TaskContext.Provider>);
test('plugin settings routes round trip with encoded ids and query, selecting their parent',()=>{
  for(const id of ['fx-ui','a b','<b>name</b>']) {
    const href=hrefFor(routes.pluginSettings(id,{repo:'repo & one',scope:'all'}));
    const route=resolveRoute(href);
    expect(route).toEqual({name:'settings',section:`plugins/${id}`,query:{repo:'repo & one',scope:'all'}});
    if('name' in route) expect(parentFor(route)).toEqual(routes.settings('plugins',route.query));
  }
  expect(titleFor({name:'settings',section:'plugins',query})).toBe('Plugins');
});
test('Plugins cards show backed additions, permissions, states and only usable links',()=>{
  const bundled={...pluginFixture,id:'bundled',bundled:true,version:'bundled'}, failing={...pluginFixture,id:'failing',state:'failing' as const,error:'<b>Failed</b>'};
  const html=draw(<PluginsPage initialData={{plugins:[pluginFixture,bundled,failing]}} initialSurfaces={surfaces}/>);
  for(const text of ['Installed · 3','Built in','Failing','Settings page','Activity view','Right-panel tab','Status bar item','Diagnostic checks','Terminal sessions','Usage reader','Routing engine','Read tasks','Read its settings','Reach the network: example.test','Where plugins appear']) expect(html).toContain(text);
  expect(html).toContain('&lt;b>Failed&lt;/b>');expect(html).not.toContain('<b>Failed</b>');
  expect(html.match(/>Settings<\/a>/g)).toHaveLength(1);
  for(const text of ['Install from file','Browse','Updates','Update to']) expect(html).not.toContain(text);
  expect(draw(<PluginsPage initialData={{plugins:[]}} initialSurfaces={{surfaces:[]}}/>)).toContain('No plugins installed.');
});
test('schema fields use board rows, defaults, constraints and text-only plugin strings',()=>{
  const data=structuredClone(settingsFixture);data.schema.fields.name!.title='<img src=x>';data.schema.fields.name!.description='<b>text</b>';
  const html=draw(<PluginSettingsPage plugin="fx-ui" initialData={data} initialPlugins={plugins} initialSurfaces={surfaces}/>);
  for(const text of ['Require before Accept','Repositories','Checklist items','Retries','Credential reference','never the secret itself','Where it shows','Checklist tab in the right panel','Open checklist items in the status bar','min="1"','max="5"','maxlength="20"','Move Run tests down','Remove Run tests','pc-setting-row--board']) expect(html).toContain(text);
  expect(html).toContain('&lt;img src=x>');expect(html).toContain('&lt;b>text&lt;/b>');expect(html).not.toContain('unsaved change');expect(html.match(/<h1/g)).toHaveLength(1);
  expect(dirtyFields(settingsDefaults(data),{...settingsDefaults(data),name:'Other',retries:3})).toBe(2);
  expect(fieldErrors({data:{errors:[{path:'values.name',message:'Fix label'}]}})).toEqual({name:'Fix label'});
});
test('browser API preserves structured field errors',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>new Response(JSON.stringify({error:{code:'invalid_input',message:'invalid',data:{errors:[{path:'name',message:'Bad name'}]}}}),{status:400})) as any;
  try {const api=createApi();await expect(api.call('plugin.settings.set',{})).rejects.toMatchObject({code:'invalid_input',data:{errors:[{path:'name',message:'Bad name'}]}});} finally {globalThis.fetch=original;}
});
const browserPath=process.env.PACER_TEST_BROWSER, browserTest=test.skipIf(!browserPath);
let browser:Browser, script:string, css:string, server:ReturnType<typeof Bun.serve>;
beforeAll(async()=>{
  if(!browserPath) return;
  const build=await Bun.build({entrypoints:['test/fixtures/ui/plugin-settings-browser.tsx'],target:'browser'});if(!build.success) throw new AggregateError(build.logs);
  script=await build.outputs[0]!.text();css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/settings/settings.css'].map(path=>Bun.file(path).text()))).join('\n');
  server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response(`<style>${css}</style><div id="app"></div>`,{headers:{'content-type':'text/html'}})});
  browser=await chromium.launch({executablePath:browserPath,headless:true});
});
afterAll(async()=>{await browser?.close();server?.stop(true);});
async function mount(fixture:unknown={}) {const page=await browser.newPage();page.setDefaultTimeout(5000);await page.goto(server.url.href);await page.evaluate(fixture=>{(window as any).fixture=fixture;},fixture);await page.addScriptTag({type:'module',content:script});await page.waitForFunction(()=>document.querySelector('h1')||document.querySelector('[aria-label="Settings pages"]'));return page;}
const calls=(page:Page,op:string)=>page.evaluate(op=>(window as any).calls.filter((c:any)=>c.op===op),op);
browserTest('Extend nav has plugin provenance, attention, current page and refresh/failure behavior',async()=>{
  const page=await mount({mode:'nav',plugins:[pluginFixture,{...pluginFixture,id:'broken',state:'failing'}]});
  try {
    const link=page.getByRole('link',{name:'Release checklist, plugin',exact:true});await link.waitFor();expect(await link.getAttribute('aria-current')).toBe('page');expect(await link.getAttribute('href')).toBe('#/settings/plugins/fx-ui');
    await page.getByText('1 plugin needs attention',{exact:true}).waitFor();
    const text=await page.locator('nav').textContent();expect(text!.indexOf('Dispatch')).toBeLessThan(text!.indexOf('Extend'));expect(text!.indexOf('Extend')).toBeLessThan(text!.lastIndexOf('App'));
    await page.evaluate(()=>{(window as any).failList=true;(window as any).emit();});await link.waitFor({state:'detached'});expect(await page.getByRole('link',{name:'Plugins',exact:true}).count()).toBe(1);
    await page.evaluate(()=>{(window as any).failList=false;(window as any).emit();});await link.waitFor();
    await page.evaluate(()=>{(window as any).failSurfaces=true;(window as any).emit();});await link.waitFor({state:'detached'});
  } finally {await page.close();}
});
browserTest('card overflow menu supports keyboard, checks, remove confirmation and bundled restrictions',async()=>{
  const page=await mount({mode:'plugins',plugins:[pluginFixture,{...pluginFixture,id:'builtin',bundled:true}]});
  try {
    const trigger=page.getByRole('button',{name:'More actions for fx-ui'});await trigger.focus();await page.keyboard.press('ArrowDown');expect(await trigger.getAttribute('aria-expanded')).toBe('true');expect(await page.getByRole('menuitem',{name:'Run checks'}).evaluate(n=>n===document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowDown');expect(await page.getByRole('menuitem',{name:'Remove…'}).evaluate(n=>n===document.activeElement)).toBe(true);await page.keyboard.press('Escape');expect(await trigger.evaluate(n=>n===document.activeElement)).toBe(true);
    await trigger.click();await page.getByRole('menuitem',{name:'Run checks'}).click();await page.getByText('Checks: ok',{exact:true}).waitFor();expect(await calls(page,'plugin.doctor')).toHaveLength(1);
    await page.evaluate(()=>{(window as any).doctorError='<b>Needs repair</b>';});await trigger.click();await page.getByRole('menuitem',{name:'Run checks'}).click();await page.getByText('<b>Needs repair</b>',{exact:true}).waitFor();expect(await page.locator('b').filter({hasText:'Needs repair'}).count()).toBe(0);
    await page.getByRole('button',{name:'More actions for builtin'}).click();expect(await page.getByRole('menuitem',{name:'Remove…'}).count()).toBe(0);await page.keyboard.press('Escape');
    await trigger.click();await page.getByRole('menuitem',{name:'Remove…'}).click();await page.getByRole('dialog',{name:'Remove plugin'}).waitFor();expect(await page.getByRole('dialog').textContent()).toContain('fx-ui');expect(await calls(page,'plugin.remove')).toHaveLength(0);await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await trigger.click();await page.getByRole('menuitem',{name:'Remove…'}).click();await page.getByRole('button',{name:'Remove',exact:true}).click();await page.getByRole('article',{name:'fx-ui',exact:true}).waitFor({state:'detached'});expect(await calls(page,'plugin.remove')).toEqual([{op:'plugin.remove',params:{id:'fx-ui'}}]);
  } finally {await page.close();}
});
browserTest('schema editing counts changes, discards, reorders, picks repos and saves with the shared revision',async()=>{
  const page=await mount();
  try {
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Other');await page.getByText('1 unsaved change',{exact:true}).waitFor();await page.getByRole('spinbutton',{name:'Retries'}).fill('4');await page.getByText('2 unsaved changes',{exact:true}).waitFor();await page.getByRole('button',{name:'Discard',exact:true}).click();expect(await page.getByRole('textbox',{name:'Label',exact:true}).inputValue()).toBe('Checklist');
    await page.getByRole('button',{name:'Move Run tests down'}).click();expect(await page.locator('.pc-plugin-ordered>li').first().textContent()).toContain('Update notes');
    await page.getByRole('textbox',{name:'New Checklist items item'}).fill('<b>Literal</b>');await page.getByRole('button',{name:'Add',exact:true}).click();expect(await page.getByText('<b>Literal</b>',{exact:true}).count()).toBe(1);
    await page.getByRole('button',{name:'Add repository',exact:true}).click();await page.getByRole('button',{name:'team/two'}).click();
    await page.getByRole('switch',{name:'Checklist tab in the right panel'}).click();await page.getByText('Saved.',{exact:true}).waitFor();expect(await calls(page,'plugin.ui.visibility')).toEqual([{op:'plugin.ui.visibility',params:{plugin:'fx-ui',surface:'panelTab',id:'checklist-tab',visible:false,expect_rev:7}}]);
    await page.getByRole('button',{name:'Second',exact:true}).click();await page.getByRole('textbox',{name:'Credential reference',exact:true}).fill('another-ref');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Saved.',{exact:true}).waitFor();await page.getByRole('button',{name:'Save',exact:true}).waitFor({state:'detached'});
    const saved=await calls(page,'plugin.settings.set');expect(saved).toHaveLength(1);expect(saved[0].params.expect_rev).toBe(8);expect(saved[0].params.values.items).toEqual(['Update notes','Run tests','<b>Literal</b>']);expect(saved[0].params.values.repos).toEqual(['repo-one','repo-two']);expect(saved[0].params.values.mode).toBe('Second');expect(saved[0].params.values.reference).toBe('another-ref');
  } finally {await page.close();}
});
browserTest('validation errors, conflicts and visibility conflicts preserve the draft',async()=>{
  const page=await mount();
  try {
    await page.getByRole('spinbutton',{name:'Retries'}).fill('99');await page.getByRole('button',{name:'Save',exact:true}).click();expect(await calls(page,'plugin.settings.set')).toHaveLength(0);await page.getByRole('spinbutton',{name:'Retries'}).fill('3');
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Other');await page.evaluate(()=>{(window as any).saveError='invalid_input';});await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Choose another label.',{exact:true}).waitFor();await page.getByText('Too many retries.',{exact:true}).waitFor();expect(await page.getByRole('textbox',{name:'Label',exact:true}).getAttribute('aria-invalid')).toBe('true');
    await page.evaluate(()=>{(window as any).saveError='conflict';});await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('These settings changed elsewhere.',{exact:false}).waitFor();expect(await page.getByRole('textbox',{name:'Label',exact:true}).inputValue()).toBe('Other');await page.getByRole('button',{name:'Load latest'}).click();await page.getByRole('button',{name:'Save',exact:true}).waitFor({state:'detached'});
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Keep draft');await page.evaluate(()=>{(window as any).visibilityConflict=true;(window as any).saveError=undefined;});await page.getByRole('switch',{name:'Checklist tab in the right panel'}).click();await page.getByText('Changed elsewhere; showing the latest.',{exact:true}).waitFor();expect(await page.getByRole('textbox',{name:'Label',exact:true}).inputValue()).toBe('Keep draft');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('button',{name:'Save',exact:true}).waitFor({state:'detached'});expect((await calls(page,'plugin.settings.set')).at(-1).params.expect_rev).toBe(8);
    await page.getByRole('button',{name:'Turn off',exact:true}).click();await page.getByText('This plugin is off.',{exact:true}).waitFor();await page.getByRole('button',{name:'Turn on',exact:true}).click();await page.getByRole('textbox',{name:'Label',exact:true}).waitFor();
  } finally {await page.close();}
});
browserTest('host error states distinguish missing and unavailable settings pages',async()=>{
  for(const [code,message] of [['unknown_plugin','This plugin has no settings page.'],['not_found','This plugin has no settings page.'],['plugin_unavailable','This plugin is turned off or needs attention.']]) {
    const page=await mount({getError:code});try{await page.getByText(message,{exact:false}).waitFor();}finally{await page.close();}
  }
});

browserTest('limits explain disabled controls and the existing navigation guard protects drafts',async()=>{
  const settings=structuredClone(settingsFixture); (settings.schema.fields.items as any).maxItems=2;(settings.schema.fields.repos as any).maxItems=1;
  const page=await mount({settings});
  try {
    await page.getByText('Maximum 2 items. Remove one to add another.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:'Add',exact:true}).isDisabled()).toBe(true);
    await page.getByText('Maximum 1 repository. Remove one to add another.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:'Add repository',exact:true}).isDisabled()).toBe(true);
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Draft');
    await page.evaluate(()=>{(window as any).leaveResult=undefined;(window as any).canLeave().then((result:boolean)=>{(window as any).leaveResult=result;});});
    await page.getByRole('dialog',{name:'Unsaved plugin settings'}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForFunction(()=>(window as any).leaveResult===false);
    await page.evaluate(()=>{(window as any).canLeave().then((result:boolean)=>{(window as any).leaveResult=result;});});await page.getByRole('button',{name:'Discard changes',exact:true}).click();await page.waitForFunction(()=>(window as any).leaveResult===true);
  } finally {await page.close();}
});

test('Plugins screens and styles stay in separate lazy chunks under the unchanged budgets',async()=>{
  const {buildApp,APP_JS_BUDGET}=await import('../app/build');const files=await buildApp();
  const main=files.find(file=>file.path==='app.js')!, cards=files.find(file=>file.text.includes('Where plugins appear'))!, editor=files.find(file=>file.text.includes("This page is drawn by pacer from the plugin's settings schema"))!;
  expect(cards).toBeDefined();expect(editor).toBeDefined();expect(cards.path).not.toBe(editor.path);expect(cards.path).not.toBe('app.js');expect(editor.path).not.toBe('app.js');
  expect(main.text).not.toContain('pc-plugin-card--attention');expect(files.find(file=>file.path==='app.css')!.text).not.toContain('.pc-plugin-provenance');
  for(const file of [main,cards,editor]) expect(Bun.gzipSync(file.text).byteLength).toBeLessThan(APP_JS_BUDGET);
});
