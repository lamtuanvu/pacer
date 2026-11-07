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

browserTest('a 1.2 session types on focus with no control row, and Ctrl-] leaves the terminal',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/conversation-terminal.tsx'],target:'browser',minify:true});
 expect(built.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  await page.setContent('<style>.pc-terminal-pane{height:300px;overflow:hidden;position:relative}.pc-terminal-mount{transform-origin:top left}</style><div id="app"></div>');
  await page.evaluate(()=>{(window as any).sessionVersions=[1,2];});
  await page.addScriptTag({content:await built.outputs[0].text()});
  const footer=page.locator('#footer'),supervised=page.locator('#supervised');
  await footer.getByText('Interactive',{exact:true}).waitFor();
  await supervised.getByText('Interactive · last input from ghostty',{exact:true}).waitFor();
  expect(await supervised.locator('.pc-terminal-strip [role="status"][aria-live="polite"]').textContent()).toBe('Interactive · last input from ghostty');
  for(const word of ['Take control','Release control','Watching · read-only','Nothing you type reaches the agent','Take over?'])expect(await page.getByText(word,{exact:false}).count()).toBe(0);
  expect(await page.getByRole('button',{name:/control/i}).count()).toBe(0);
  const sent=()=>page.evaluate(()=>(window as any).conversationFixture.sent() as string[]);

  // Focusing a pane makes it the active client; its keystrokes reach the agent without take.
  await page.locator('#supervised .xterm-helper-textarea').focus();
  await page.waitForFunction(()=>((window as any).conversationFixture.sent() as string[]).includes('supervised:focus'));
  await page.keyboard.press('x');
  await page.waitForFunction(()=>((window as any).conversationFixture.sent() as string[]).includes('supervised:input'));
  expect((await sent()).filter(frame=>/:(take|release)$/.test(frame))).toEqual([]);
  expect(await supervised.locator('.pc-terminal-view').getAttribute('data-session-control')).toBe('true');
  expect(await page.locator('#session-panel .pc-terminal-view').getAttribute('data-session-control')).toBe('false');
  // A focused pane's Ctrl combinations stay with the agent.
  await page.evaluate(()=>{(window as any).seen=[];addEventListener('keydown',(e:Event)=>{const k=e as KeyboardEvent;if(k.key==='b')(window as any).seen.push(k.key);});});
  await page.keyboard.press('Control+b');
  expect(await page.evaluate(()=>(window as any).seen)).toEqual([]);

  // Ctrl-] moves focus to the next control after the terminal without sending anything; Tab continues from there.
  const before=(await sent()).length;
  await page.keyboard.press('Control+BracketRight');
  expect(await page.evaluate(()=>document.activeElement?.closest('#supervised .pc-terminal-strip')!==null)).toBe(true);
  expect(await supervised.locator('.pc-terminal-view').getAttribute('data-session-control')).toBe('false');
  expect((await sent()).length).toBe(before);
  // F1: once focus has left the terminal, app shortcuts run again from the control it landed on.
  expect(await supervised.locator('.pc-terminal-pane').getAttribute('aria-label')).toBe('Codex terminal, interactive');
  await page.keyboard.press('Control+k');
  expect(await page.evaluate(()=>(window as any).conversationFixture.shortcuts())).toEqual(['Mod-k']);
  // Inside the terminal the same keys belong to the agent.
  await page.locator('#supervised .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+k');
  expect(await page.evaluate(()=>(window as any).conversationFixture.shortcuts())).toEqual(['Mod-k']);
  await page.keyboard.press('Control+BracketRight');
  await page.keyboard.press('Control+k');
  expect(await page.evaluate(()=>(window as any).conversationFixture.shortcuts())).toEqual(['Mod-k','Mod-k']);
  // The conversation pane does the same, landing on its footer controls.
  await page.locator('#session-panel .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+BracketRight');
  expect(await page.evaluate(()=>document.activeElement?.closest('#footer')!==null)).toBe(true);
 }finally{await browser.close();}
},20000);

browserTest('a 1.2 takeover hands back once, after confirming, and reports a failure',async()=>{
 const built=await Bun.build({entrypoints:['test/fixtures/ui/conversation-terminal.tsx'],target:'browser',minify:true});
 expect(built.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:900}});
  await page.setContent('<style>.pc-terminal-pane{height:200px;overflow:hidden;position:relative}.pc-terminal-mount{transform-origin:top left}</style><div id="app"></div>');
  // Each hand back waits until the test settles it.
  await page.evaluate(()=>{const w=window as any;w.sessionVersions=[1,2];w.handBacks=0;w.handBack=()=>{w.handBacks++;return new Promise((resolve,reject)=>{w.settle=(error?:string)=>error?reject(new Error(error)):resolve(undefined);});};});
  await page.addScriptTag({content:await built.outputs[0].text()});
  const takeover=page.locator('#takeover'),button=takeover.getByRole('button',{name:'Hand back',exact:true});
  await button.waitFor();
  const calls=()=>page.evaluate(()=>(window as any).handBacks as number);
  // Cancelling the confirmation sends nothing.
  await button.click();
  const dialog=page.getByRole('dialog');
  expect(await dialog.textContent()).toContain('This ends your session and sends the task to review.');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  expect(await calls()).toBe(0);
  // Confirmed: one request, the button busy, and a second activation does nothing.
  await button.click();
  await dialog.getByRole('button',{name:'Hand back',exact:true}).click();
  await page.waitForFunction(()=>(window as any).handBacks===1);
  expect(await button.getAttribute('aria-busy')).toBe('true');
  expect(await button.isDisabled()).toBe(true);
  await button.dispatchEvent('click');await button.dispatchEvent('click');
  expect(await page.getByRole('dialog').count()).toBe(0);
  expect(await calls()).toBe(1);
  // A refusal is shown as an alert and the button can be used again.
  await page.evaluate(()=>(window as any).settle('This task is not in a takeover session; nothing to hand back.'));
  await takeover.getByRole('alert').filter({hasText:'nothing to hand back'}).waitFor();
  expect(await button.isDisabled()).toBe(false);
  // Success moves focus to the terminal pane, not the page body.
  await button.click();
  await dialog.getByRole('button',{name:'Hand back',exact:true}).click();
  await page.waitForFunction(()=>(window as any).handBacks===2);
  await page.evaluate(()=>(window as any).settle());
  await page.waitForFunction(()=>document.activeElement?.classList.contains('pc-terminal-pane')&&document.activeElement.closest('#takeover')!==null);
  expect(await takeover.getByRole('alert').count()).toBe(0);
 }finally{await browser.close();}
},20000);
