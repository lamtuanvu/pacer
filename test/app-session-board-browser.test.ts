import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chromium,type Browser} from 'playwright-core';
const browserTest=test.skipIf(!process.env.PACER_TEST_BROWSER);
let browser:Browser, server:ReturnType<typeof Bun.serve>;
beforeAll(async()=>{
 if(!process.env.PACER_TEST_BROWSER)return;
 const built=await Bun.build({entrypoints:['test/fixtures/ui/session-panel-board.tsx'],target:'browser',minify:true});
 if(!built.success)throw new AggregateError(built.logs);
 const js=await built.outputs[0]!.text();
 const css=(await Promise.all(['app/src/ds/tokens.css','app/src/ds/components.css','app/src/styles.css','app/src/screens/session/session.css','app/src/screens/session/file-viewer.css'].map(p=>Bun.file(p).text()))).join('\n');
 server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:r=>new URL(r.url).pathname==='/fixture.js'?new Response(js,{headers:{'content-type':'text/javascript'}}):new Response(`<meta charset="utf-8"><style>${css}\n.pc-session-test-frame{display:flex;height:100vh}.pc-session-test-frame>.pc-task-workspace{flex:1;min-width:0}.pc-session-test-frame .pc-side-panel__content{flex:1}</style><div id="root"></div><script type="module" src="/fixture.js"></script>`,{headers:{'content-type':'text/html'}})});
 browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER,headless:true});
},30000);
afterAll(async()=>{await browser?.close();server?.stop(true);});
browserTest('session file tabs preserve terminal, use a desktop pane, and close back to Details',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 try {
  await page.goto(server.url.toString());
  await page.getByRole('button',{name:'reports/demo.md',exact:true}).click();
  await page.getByRole('region',{name:/File viewer/}).waitFor();
  expect(await page.locator('[data-layout]').getAttribute('data-layout')).toBe('pane');
  expect((await page.locator('.pc-side-panel--right').boundingBox())!.width).toBe(560);
  await page.getByRole('button',{name:'Back to terminal',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('id')==='session-t-file-panel-details-tab',{},{timeout:2000});
  await page.getByRole('button',{name:'reports/demo.md',exact:true}).click();
  await page.locator('[data-layout=pane]').waitFor();
  expect(await page.getByLabel('Terminal fixture').isVisible()).toBe(true);
  await page.getByRole('tab',{name:'Details',exact:true}).click();
  await page.getByRole('button',{name:'src/other.ts',exact:true}).click();
  await page.getByRole('tab',{name:'other.ts',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close src/other.ts',exact:true}).click();
  expect(await page.getByRole('tab',{name:'Details',exact:true}).getAttribute('aria-selected')).toBe('true');
  expect((await page.locator('.pc-side-panel--right').boundingBox())!.width).toBe(300);
  await page.getByRole('tab',{name:'Details',exact:true}).press('ArrowRight');
  expect(await page.getByRole('tab',{name:'Changes 2',exact:true}).getAttribute('aria-selected')).toBe('true');
 }finally{await page.close();}
},30000);
