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
  expect(html).not.toContain('role="tablist"');
  expect(html).toContain('aria-labelledby="plugins-installed-label"');
  for(const text of ['Install from file','Browse','Updates','Update to']) expect(html).not.toContain(text);
  expect(draw(<PluginsPage initialData={{plugins:[]}} initialSurfaces={{surfaces:[]}}/>)).toContain('No plugins installed.');
});
test('schema fields use board rows, defaults, constraints and text-only plugin strings',()=>{
  const data=structuredClone(settingsFixture);data.schema.fields.name!.title='<img src=x>';data.schema.fields.name!.description='<b>text</b>';
  const html=draw(<PluginSettingsPage plugin="fx-ui" initialData={data} initialPlugins={plugins} initialSurfaces={surfaces}/>);
  for(const text of ['Require before Accept','Repositories','Checklist items','Retries','Credential reference','never the secret itself','Where it shows','Checklist tab in the right panel','Open checklist items in the status bar','min="1"','max="5"','maxlength="20"','Move down: Run tests','Remove Run tests','pc-setting-row--board']) expect(html).toContain(text);
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
async function mount(fixture:unknown={},options:Parameters<Browser["newPage"]>[0]={}) {const page=await browser.newPage(options);page.setDefaultTimeout(5000);await page.goto(server.url.href);await page.evaluate(fixture=>{(window as any).fixture=fixture;},fixture);await page.addScriptTag({type:'module',content:script});await page.waitForFunction(()=>document.querySelector('h1')||document.querySelector('[aria-label="Settings pages"]'));return page;}
const calls=(page:Page,op:string)=>page.evaluate(op=>(window as any).calls.filter((c:any)=>c.op===op),op);
browserTest('Extend nav has plugin provenance, attention, current page and refresh/failure behavior',async()=>{
  const page=await mount({mode:'nav',plugins:[pluginFixture,{...pluginFixture,id:'broken',state:'failing'}]});
  try {
    const link=page.getByRole('link',{name:'Release checklist, plugin',exact:true});await link.waitFor();expect(await link.getAttribute('aria-current')).toBe('page');expect(await link.getAttribute('href')).toBe('#/settings/plugins/fx-ui');
    await page.getByText('1 plugin needs attention',{exact:true}).waitFor();
    const text=await page.locator('nav').textContent();expect(text!.indexOf('Dispatch')).toBeLessThan(text!.indexOf('Extend'));expect(text!.indexOf('Extend')).toBeLessThan(text!.lastIndexOf('App'));
    await page.evaluate(()=>{(window as any).failList=true;(window as any).emit();});await link.waitFor({state:'detached'});expect(await page.getByRole('link',{name:'Plugins',exact:true}).count()).toBe(1);
    await page.evaluate(()=>{(window as any).failList=false;(window as any).emit();});await link.waitFor();
    await page.evaluate(()=>{(window as any).failSurfaces=true;(window as any).emit();});await page.waitForTimeout(150);expect(await link.count()).toBe(1);
  } finally {await page.close();}
});
browserTest('card overflow menu supports keyboard, checks, remove confirmation and bundled restrictions',async()=>{
  const page=await mount({mode:'plugins',plugins:[pluginFixture,{...pluginFixture,id:'builtin',bundled:true}]});
  try {
    const trigger=page.getByRole('button',{name:'More actions for fx-ui'});await trigger.focus();await page.keyboard.press('ArrowDown');expect(await trigger.getAttribute('aria-expanded')).toBe('true');expect(await page.getByRole('menuitem',{name:'Run checks'}).evaluate(n=>n===document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowDown');expect(await page.getByRole('menuitem',{name:'Remove…'}).evaluate(n=>n===document.activeElement)).toBe(true);await page.keyboard.press('Escape');expect(await trigger.evaluate(n=>n===document.activeElement)).toBe(true);
    await trigger.click();await page.getByRole('menuitem',{name:'Run checks'}).click();await page.getByText('Checks passed.',{exact:true}).waitFor();expect(await calls(page,'plugin.doctor')).toHaveLength(1);
    await page.evaluate(()=>{(window as any).doctorError='<b>Needs repair</b>';});await trigger.click();await page.getByRole('menuitem',{name:'Run checks'}).click();await page.getByText('Checks found a problem: <b>Needs repair</b>',{exact:true}).waitFor();expect(await page.locator('b').filter({hasText:'Needs repair'}).count()).toBe(0);
    await page.getByRole('button',{name:'More actions for builtin'}).click();expect(await page.getByRole('menuitem',{name:'Remove…'}).count()).toBe(0);await page.keyboard.press('Escape');
    await trigger.click();await page.getByRole('menuitem',{name:'Remove…'}).click();await page.getByRole('dialog',{name:'Remove plugin'}).waitFor();expect(await page.getByRole('dialog').textContent()).toContain('fx-ui');expect(await calls(page,'plugin.remove')).toHaveLength(0);await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await trigger.click();await page.getByRole('menuitem',{name:'Remove…'}).click();await page.getByRole('button',{name:'Remove',exact:true}).click();await page.getByRole('article',{name:'fx-ui',exact:true}).waitFor({state:'detached'});expect(await calls(page,'plugin.remove')).toEqual([{op:'plugin.remove',params:{id:'fx-ui'}}]);
  } finally {await page.close();}
});
browserTest('schema editing counts changes, discards, reorders, picks repos and saves with the shared revision',async()=>{
  const page=await mount();
  try {
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Other');await page.getByText('1 unsaved change',{exact:true}).waitFor();await page.getByRole('spinbutton',{name:'Retries'}).fill('4');await page.getByText('2 unsaved changes',{exact:true}).waitFor();await page.getByRole('button',{name:'Discard',exact:true}).click();expect(await page.getByRole('textbox',{name:'Label',exact:true}).inputValue()).toBe('Checklist');
    await page.getByRole('button',{name:'Move down: Run tests'}).click();expect(await page.locator('.pc-plugin-ordered>li').first().textContent()).toContain('Update notes');
    await page.getByRole('textbox',{name:'Checklist items: new item'}).fill('<b>Literal</b>');await page.getByRole('button',{name:'Add',exact:true}).click();expect(await page.getByText('<b>Literal</b>',{exact:true}).count()).toBe(1);
    await page.getByRole('button',{name:'Add repository',exact:true}).click();await page.getByRole('button',{name:'team/two'}).click();
    await page.getByRole('switch',{name:'Checklist tab in the right panel'}).click();await page.waitForFunction(() => !(window as any).calls.length || document.querySelector('[role="status"]')?.textContent !== 'Saving…');expect(await page.getByText('Saved.',{exact:true}).count()).toBe(0);expect(await calls(page,'plugin.ui.visibility')).toEqual([{op:'plugin.ui.visibility',params:{plugin:'fx-ui',surface:'panelTab',id:'checklist-tab',visible:false,expect_rev:7}}]);
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
    await page.getByText('Maximum 2 items. Remove one to add another.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:'Add',exact:true}).getAttribute('aria-disabled')).toBe('true');
    await page.getByText('Maximum 1 repository. Remove one to add another.',{exact:true}).waitFor();expect(await page.getByRole('button',{name:'Add repository',exact:true}).getAttribute('aria-disabled')).toBe('true');
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

test('blank optional references and untouched enums pass the real settings validator',async()=>{
  const {settingsPayload}=await import('../app/src/screens/settings/PluginSettingsPage');
  const {validateSettings}=await import('../src/plugins/settings');
  const data=structuredClone(settingsFixture);data.values={name:'Saved'};
  const baseline=settingsDefaults(data), draft={...baseline,name:'Edited'};
  expect(baseline.reference).toBe('');expect(baseline.mode).toBe('');
  expect(validateSettings(data.schema,draft).length).toBeGreaterThan(0);
  const payload=settingsPayload(data,baseline,draft);
  expect(payload).toEqual({name:'Edited'});expect(validateSettings(data.schema,payload)).toEqual([]);
});

browserTest('one visibility change shares the catalog and preserves draft save feedback',async()=>{
  const page=await mount({eventBurst:true});
  try {
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Draft');
    const before=(await calls(page,'plugin.ui.list')).length;
    await page.getByRole('switch',{name:'Checklist tab in the right panel'}).click();
    await page.waitForFunction(()=>!(document.querySelector('[role="switch"][aria-label="Checklist tab in the right panel"]')?.getAttribute('aria-disabled')==='true'));
    await page.waitForTimeout(200);
    expect((await calls(page,'plugin.ui.list')).length-before).toBeLessThanOrEqual(2);
    expect(await page.getByText('Saved.',{exact:true}).count()).toBe(0);
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByText('Saved.',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Another draft');
    expect(await page.getByText('Saved.',{exact:true}).count()).toBe(0);
    expect(await page.getByText('These switches save at once.',{exact:false}).count()).toBe(1);
  } finally {await page.close();}
});

browserTest('turning off a dirty plugin confirms discarding and clears its guard',async()=>{
  const page=await mount();
  try {
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Draft');
    await page.getByRole('button',{name:'Turn off',exact:true}).click();
    await page.getByText('Discard 1 unsaved change and turn off fx-ui?',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    expect(await calls(page,'plugin.disable')).toHaveLength(0);
    expect(await page.getByRole('textbox',{name:'Label',exact:true}).inputValue()).toBe('Draft');
    await page.getByRole('button',{name:'Turn off',exact:true}).click();
    await page.getByRole('button',{name:'Discard and turn off',exact:true}).click();
    await page.getByText('This plugin is off.',{exact:true}).waitFor();
    expect(await page.evaluate(()=>(window as any).canLeave())).toBe(true);
  } finally {await page.close();}
});

browserTest('revision-only save conflict retries once automatically and preserves edited values',async()=>{
  const page=await mount();
  try {
    await page.getByRole('textbox',{name:'Label',exact:true}).fill('Retry draft');
    await page.evaluate(()=>{(window as any).revisionConflict=true;});
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByText('Saved.',{exact:true}).waitFor();
    expect((await calls(page,'plugin.settings.set')).map((c:any)=>c.params.expect_rev)).toEqual([7,8]);
    expect(await page.getByRole('textbox',{name:'Label',exact:true}).inputValue()).toBe('Retry draft');
    expect(await page.getByText('These settings changed elsewhere.',{exact:true}).count()).toBe(0);
  } finally {await page.close();}
});

browserTest('range and item-limit reasons describe their controls, with touch-size menu and remove targets',async()=>{
  const settings=structuredClone(settingsFixture);(settings.schema.fields.items as any).maxItems=2;
  const page=await mount({settings});
  try {
    const input=page.getByRole('spinbutton',{name:'Retries'});await input.fill('99');
    expect(await input.evaluate(node=>document.getElementById(node.getAttribute('aria-describedby')!)?.textContent)).toBe('Enter a whole number between 1 and 5.');
    const add=page.getByRole('button',{name:'Add',exact:true});
    expect(await add.evaluate(node=>document.getElementById(node.getAttribute('aria-describedby')!)?.textContent)).toBe('Maximum 2 items. Remove one to add another.');
    expect(await page.getByRole('textbox',{name:'Checklist items: new item'}).getAttribute('placeholder')).toBe('Add an item');
  } finally {await page.close();}
});

test('nav marker contrast, card tones, overflow icon and query-preserving destinations',async()=>{
  const {NavigationProvider}=await import('../app/src/navigation');
  const html=draw(<NavigationProvider route={{name:'settings',section:'plugins',query:{repo:'one',scope:'all'}}} location={{hash:'#/settings/plugins',replace(){}}}><PluginsPage initialData={{plugins:[pluginFixture,{...pluginFixture,id:'disabled',enabled:false,state:'disabled'},{...pluginFixture,id:'bad',state:'refused'}]}} initialSurfaces={surfaces}/></NavigationProvider>);
  expect(html).toContain('href="#/settings/plugins/fx-ui?repo=one&amp;scope=all"');
  expect(html.match(/>Off</g)).toHaveLength(1);expect(html).toContain('pc-plugin-card--bad');
  expect(html).toContain('cx="5"');expect(html).toContain('cx="12"');expect(html).toContain('cx="19"');
  const css=await Bun.file('app/src/ds/components.css').text();
  expect(css.match(/\.pc-settings-nav__plugin\{[^}]+\}/)?.[0]).toContain('color:var(--ink-secondary)');
});

browserTest('settings title is restored when its page unmounts',async()=>{
  const page=await mount();
  try {
    await page.waitForFunction(()=>document.title==='Release checklist');
    await page.evaluate(()=>(window as any).unmount());
    await page.waitForFunction(()=>document.title==='');
  } finally {await page.close();}
});

browserTest('overflow, repository and list removal controls honour coarse pointer touch targets',async()=>{
  for(const mode of ['plugins','settings']) {
    const page=await mount({mode},{hasTouch:true,viewport:{width:375,height:900}});
    try {
      const target=mode==='plugins'?page.getByRole('button',{name:'More actions for fx-ui'}):page.getByRole('button',{name:'Remove Run tests'});
      await target.waitFor();
      const size=await target.evaluate(node=>{const rect=node.getBoundingClientRect();return {width:rect.width,height:rect.height,min:Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-touch'))};});
      expect(size.width).toBeGreaterThanOrEqual(size.min);expect(size.height).toBeGreaterThanOrEqual(size.min);
      if(mode==='settings') {const repo=await page.getByRole('button',{name:'Remove team/one'}).boundingBox();expect(repo!.width).toBeGreaterThanOrEqual(size.min);expect(repo!.height).toBeGreaterThanOrEqual(size.min);}
    } finally {await page.close();}
  }
});

test('plugin resource invalidation ignores unrelated areas',async()=>{
  const {resourceRevision}=await import('../app/src/screens/settings/shared');
  expect(resourceRevision('plugin.list',{plugin:1,tasks:5})).toBe(resourceRevision('plugin.list',{plugin:1,tasks:6}));
  expect(resourceRevision('plugin.list',{plugin:2})).not.toBe(resourceRevision('plugin.list',{plugin:1}));
});

browserTest('repository chips display picker labels, remove by key and preserve unknown keys',async()=>{
  const settings=structuredClone(settingsFixture);settings.values.repos=['repo-one','unknown-repo'];
  const page=await mount({settings});
  try {
    await page.getByRole('button',{name:'Remove team/one',exact:true}).waitFor();
    expect(await page.locator('.pc-plugin-repo').allTextContents()).toEqual(['team/one×','unknown-repo×']);
    await page.getByRole('button',{name:'Remove team/one',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByText('Saved.',{exact:true}).waitFor();
    expect((await calls(page,'plugin.settings.set'))[0].params.values.repos).toEqual(['unknown-repo']);
  } finally {await page.close();}
});
browserTest('App and plugin pages retain the shared frame and controls',async()=>{
  const frame=(page:Page)=>page.locator('.pc-page').evaluate(node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return {padding:s.padding,maxWidth:s.maxWidth,x:r.x,width:r.width,content:node.firstElementChild!.getBoundingClientRect().width};});
  const app=await mount({mode:'app'},{viewport:{width:1440,height:900}}), cards=await mount({mode:'plugins'},{viewport:{width:1440,height:900}}), editor=await mount({},{viewport:{width:1440,height:900}});
  const style=(page:Page,selector:string)=>page.locator(selector).first().evaluate(node=>{const s=getComputedStyle(node);return {height:s.height,width:s.width,padding:s.padding,radius:s.borderRadius,color:s.color,fontSize:s.fontSize,weight:s.fontWeight,align:s.alignItems};});
  try {
    const appFrame=await frame(app);expect(appFrame.padding).toBe('24px 32px 40px');expect(appFrame.maxWidth).toBe('none');expect(appFrame.content).toBe(1376);
    const expected=await frame(cards);expect(expected.padding).toBe('24px 32px 40px');expect(expected.maxWidth).toBe('none');expect(expected.content).toBe(1376);
    expect(await frame(editor)).toEqual(expected);
    expect((await style(editor,'.pc-setting-row')).align).toBe('start');
    expect(await style(cards,'.pc-plugin-settings-link')).toMatchObject({height:'32px',padding:'0px 12px',radius:'8px',fontSize:'13px',weight:'600'});
    expect(await style(cards,'.pc-action-menu__trigger')).toMatchObject({width:'32px',height:'32px',radius:'6px'});
    expect((await style(cards,'.pc-action-menu__trigger')).color).toBe('rgb(82, 82, 91)');
    expect(await style(editor,'.pc-plugin-remove')).toMatchObject({width:'26px',height:'26px',padding:'0px',radius:'6px'});
    expect(await editor.locator('.pc-plugin-remove').first().evaluate(node=>{const probe=document.createElement('span');probe.style.color='var(--ink-secondary)';document.body.append(probe);const want=getComputedStyle(probe).color;probe.remove();return getComputedStyle(node).color===want;})).toBe(true);
    const row=await editor.locator('.pc-plugin-ordered>li').first().evaluate(node=>{const s=getComputedStyle(node);return {height:node.getBoundingClientRect().height,columns:s.gridTemplateColumns.split(' ').length,padding:s.padding,radius:s.borderRadius};});
    expect(row).toMatchObject({height:44,columns:4,padding:'8px 10px',radius:'8px'});
    expect(await editor.getByRole('button',{name:'Move up: Run tests',exact:true}).count()).toBe(0);
    expect(await editor.getByRole('button',{name:'Move down: Update notes',exact:true}).count()).toBe(0);
    await editor.getByRole('button',{name:'Move down: Run tests',exact:true}).focus();await editor.keyboard.press('Enter');
    expect(await editor.locator('.pc-plugin-ordered>li').first().textContent()).toBe('Update notes×');
    const focused=(label:string)=>editor.waitForFunction(label=>document.activeElement?.getAttribute('aria-label')===label,label,{timeout:2000});
    await focused('Move up: Run tests');
    await editor.getByRole('textbox',{name:'Checklist items: new item'}).fill('Ship it');await editor.keyboard.press('Enter');
    await editor.getByRole('button',{name:'Move down: Update notes',exact:true}).focus();
    await editor.keyboard.press('Enter');await focused('Move down: Update notes');
    await editor.keyboard.press('Enter');await focused('Move up: Update notes');
    expect(await editor.locator('.pc-plugin-ordered__text').allTextContents()).toEqual(['Run tests','Ship it','Update notes']);
    for(const [page,selector] of [[app,'.pc-plugin-manage'],[editor,'.pc-plugin-provenance>.pc-text-action']] as const) {
      expect((await style(page,selector)).fontSize).toBe('12px');
      const link=page.locator(selector);expect(await link.evaluate(node=>getComputedStyle(node).color)).toBe(await link.evaluate(node=>{const probe=document.createElement('span');probe.style.color='var(--link)';node.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color;}));
      await link.hover();expect(await link.evaluate(node=>getComputedStyle(node).color)).toBe(await link.evaluate(node=>{const probe=document.createElement('span');probe.style.color='var(--ink)';node.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color;}));
    }
    await editor.getByRole('button',{name:'Add repository',exact:true}).click();
    const popup=await editor.locator('.pc-search-picker__popover').boundingBox(),trigger=await editor.getByRole('button',{name:'Add repository',exact:true}).boundingBox();expect(popup!.x).toBe(trigger!.x);
  } finally {await app.close();await cards.close();await editor.close();}
});
browserTest('narrow card actions align at the right with and without Settings',async()=>{
  const page=await mount({mode:'plugins',plugins:[pluginFixture,{...pluginFixture,id:'builtin',bundled:true}]},{viewport:{width:375,height:812}});
  try {
    for(const card of await page.locator('.pc-plugin-card').all()) {
      const actions=await card.locator('.pc-plugin-card__actions').boundingBox(),trigger=await card.getByRole('button',{name:/More actions/}).boundingBox();
      expect(trigger!.x+trigger!.width).toBeCloseTo(actions!.x+actions!.width,0);
    }
    const card=page.getByRole('article',{name:'fx-ui',exact:true}),settings=await card.getByRole('link',{name:'Settings',exact:true}).boundingBox(),more=await card.getByRole('button',{name:/More actions/}).boundingBox();expect(settings!.y+settings!.height/2).toBe(more!.y+more!.height/2);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  } finally {await page.close();}
});

test('bundled plugin cards use host display copy and render actual versions', () => {
  const html = draw(<PluginsPage initialData={{plugins:[
    {...pluginFixture,id:'pacer-agent-session',bundled:true,version:'2.3.4',publisher:'pacer'},
    {...pluginFixture,id:'pacer-assistant',bundled:true,version:'bundled',publisher:'pacer'},
    {...pluginFixture,id:'third-party',bundled:false},
    {...pluginFixture,id:'pacer-assistant',bundled:false},
  ]}}/>);
  for (const text of ['Agent sessions','Live terminal sessions for delegated tasks','Assistant','The always-on assistant behind ⌘J','2.3.4 · by pacer','bundled · by pacer','third-party']) expect(html).toContain(text);
  expect(html).toContain('aria-label="Enable Agent sessions"');
  expect(html).toContain('<b>pacer-assistant</b>');
  expect(html).not.toContain('<b>pacer-agent-session</b>');
});
