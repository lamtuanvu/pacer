import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
const browserTest=test.skipIf(!process.env.PACER_TEST_BROWSER);

browserTest('conversation terminal portals its controls to the footer and never fits a hidden pane',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/conversation-terminal.tsx'],target:'browser',minify:true});
 expect(built.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  await page.setContent('<style>.pc-terminal-pane{height:300px;overflow:hidden;position:relative}.pc-terminal-mount{transform-origin:top left}</style><div id="app"></div>');
  await page.addScriptTag({content:await built.outputs[0].text()});
  const footer=page.locator('#footer'),supervised=page.locator('#supervised');
  // Both terminals take control automatically on connect.
  await footer.getByText('You have control',{exact:true}).waitFor();
  await footer.getByRole('button',{name:'Release control',exact:true}).click();
  await footer.getByText('Watching · read-only',{exact:true}).waitFor();
  // The conversation strip lives in the footer; the supervised terminal keeps its inline strip.
  expect(await page.locator('#session-panel .pc-terminal-strip').count()).toBe(0);
  expect(await footer.getByRole('button',{name:'Take control',exact:true}).count()).toBe(1);
  expect(await footer.getByText('Closing this window leaves your conversation running.',{exact:false}).count()).toBe(1);
  expect(await supervised.locator('.pc-terminal-strip').count()).toBe(1);
  expect(await page.locator('#footer .pc-session-control').count()).toBe(1);

  // A watcher can Tab out of the terminal to reach the footer controls.
  await page.locator('#session-panel .xterm-helper-textarea').focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(()=>document.activeElement?.closest('#footer')!==null)).toBe(true);
  // A watcher's Ctrl combinations reach the app (its frame shortcuts), not the terminal; a driver's stay with the agent.
  await page.evaluate(()=>{(window as any).seen=[];addEventListener('keydown',(e:Event)=>{const k=e as KeyboardEvent;if(k.key==='b')(window as any).seen.push([k.key,k.defaultPrevented]);});});
  await page.locator('#session-panel .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+b');
  expect(await page.evaluate(()=>(window as any).seen)).toEqual([['b',false]]);
  await footer.getByRole('button',{name:'Take control',exact:true}).click();
  await footer.getByText('You have control',{exact:true}).waitFor();
  await page.waitForFunction(()=>(window as any).conversationFixture.sizes().length>0);
  await page.evaluate(()=>{(window as any).seen=[];});
  await page.locator('#session-panel .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+b');
  expect(await page.evaluate(()=>(window as any).seen)).toEqual([]);
  const fitted=await page.evaluate(()=>(window as any).conversationFixture.sizes().at(-1));

  // Another tab hides the panel: the pane measures 0×0 and must not shrink the agent's PTY.
  await page.evaluate(()=>(window as any).conversationFixture.hide(true));
  await page.waitForTimeout(400);
  expect(await page.evaluate(()=>(window as any).conversationFixture.sizes().at(-1))).toBe(fitted);
  await page.evaluate(()=>(window as any).conversationFixture.hide(false));
  await page.waitForTimeout(400);
  expect(await page.evaluate(()=>(window as any).conversationFixture.sizes().at(-1))).toBe(fitted);
 }finally{await browser.close();}
},20000);
