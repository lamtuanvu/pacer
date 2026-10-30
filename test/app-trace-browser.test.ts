import {expect,test} from "bun:test";
import {chromium} from "playwright-core";

const browserTest=test.skipIf(!process.env.PACER_TEST_BROWSER);
browserTest("trace renders recorded decisions and subtasks with usable links and board geometry",async()=>{
 const result=await Bun.build({entrypoints:["test/fixtures/trace-browser.tsx"],target:"browser",minify:true});
 expect(result.success).toBe(true);
 const source=await result.outputs[0]!.text();
 const css=(await Promise.all(["app/src/ds/tokens.css","app/src/ds/components.css","app/src/ds/feedback.css","app/src/styles.css","app/src/screens/trace/trace.css"].map(p=>Bun.file(p).text()))).join("\n");
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  for(const width of [1440,1920,375])for(const theme of ["light","dark"] as const){
   const page=await browser.newPage({viewport:{width,height:width===1920?1080:900},colorScheme:theme});
   await page.route("http://pacer.test/**",route=>route.fulfill({contentType:"text/html",body:`<!doctype html><style>${css}</style><div id="app"></div>`}));
   await page.goto("http://pacer.test/?scenario=long#/tasks/trace-root/trace");
   await page.addScriptTag({content:source});
   await page.locator(".pc-trace__subtask").waitFor();
   expect(await page.getByRole("heading",{name:"Dispatch trace",exact:true}).count()).toBe(1);
   expect(await page.getByRole("button",{name:"Accept result"}).count()).toBe(1);
   expect(await page.locator(".pc-trace__cost>div").count()).toBe(4);
   expect(await page.locator(".pc-trace__candidate").count()).toBe(2);
   expect(await page.locator(".pc-trace__candidate-head").innerText()).toContain("capable with spare capacity");
   expect(await page.locator(".pc-trace__subtask").innerText()).toContain("1.2k");
   const geometry=await page.evaluate(()=>{
    const title=document.querySelector(".pc-trace h1")!,circle=document.querySelector(".pc-trace__circle")!;
    return {font:getComputedStyle(title).fontSize,weight:getComputedStyle(title).fontWeight,circle:circle.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth};
   });
   expect(geometry).toEqual({font:"28px",weight:"650",circle:26,overflow:false});
   const design=await page.evaluate(()=>{
    const style=(selector:string)=>getComputedStyle(document.querySelector(selector)!);
    return {
     doneGlyph:document.querySelector(".pc-trace__circle--done")?.textContent,
     currentGlyph:document.querySelector(".pc-trace__circle--current")?.textContent,
     currentRail:document.querySelector(".pc-trace__circle--current")?.parentElement?.querySelector(".pc-trace__line")!=null,
     overflow:style(".pc-trace__subtasks").overflow,
     acceptanceDisplay:style(".pc-trace__acceptance-result").display,
     acceptanceGap:style(".pc-trace__acceptance-result").gap,
     acceptanceWeight:style(".pc-trace__acceptance-result .pc-trace__state").fontWeight,
    };
   });
   // Resolve token colours through the browser rather than comparing rgb() with hex.
   expect(await page.locator(".pc-trace__breadcrumb a").evaluate(el=>{const probe=document.createElement("span");probe.style.color="var(--link)";el.append(probe);const same=getComputedStyle(el).color===getComputedStyle(probe).color;probe.remove();return same;})).toBe(true);
   expect(design).toMatchObject({doneGlyph:"✓",currentGlyph:"◐",currentRail:false,overflow:"hidden",acceptanceDisplay:"flex",acceptanceGap:"6px",acceptanceWeight:"700"});
   expect(await page.locator(".pc-trace__token-name").innerText()).toContain("1 subtask");
   expect(await page.locator(".pc-trace__acceptance-result").innerText()).toMatch(/48 tests · \d{2}:\d{2}$/);
   for (const [selector,background,foreground] of [[".pc-trace__circle--done","--good-bg","--good-fg"],[".pc-trace__circle--current","--info-bg","--info-fg"],[".pc-trace__acceptance-result .pc-trace__state",null,"--good-fg"]] as const) {
    expect(await page.locator(selector).first().evaluate((el,{background,foreground})=>{const probe=document.createElement("span");probe.style.color=`var(${foreground})`;if(background)probe.style.backgroundColor=`var(${background})`;el.append(probe);const actual=getComputedStyle(el),expected=getComputedStyle(probe);const match=actual.color===expected.color && (!background || actual.backgroundColor===expected.backgroundColor);probe.remove();return match;},{background,foreground})).toBe(true);
   }
   await page.getByRole("button",{name:"Accept result"}).focus();
   expect(await page.evaluate(()=>document.activeElement?.matches("button.pc-btn--primary"))).toBe(true);
   await page.close();
  }
  for(const scenario of ["running","error","tree-error","null-proposal","routing-only","no-candidates","root-only"]){
   const page=await browser.newPage();
   await page.route("http://pacer.test/**",route=>route.fulfill({contentType:"text/html",body:`<!doctype html><style>${css}</style><div id="app"></div>`}));
   await page.goto(`http://pacer.test/?scenario=${scenario}#/tasks/trace-root/trace`);await page.addScriptTag({content:source});
   if(["routing-only","no-candidates","root-only"].includes(scenario)){
    await page.locator(".pc-trace__steps").waitFor();
    const candidates=await page.locator(".pc-trace__candidates").innerText();
    if(scenario==="routing-only"){
     expect(await page.locator(".pc-trace__candidate").count()).toBe(2);
     expect(candidates).toContain("From the routing record; no dispatch decision was stored.");
     expect(candidates).not.toContain("No alternatives were recorded for this step.");
    }else if(scenario==="no-candidates"){
     expect(await page.locator(".pc-trace__candidate").count()).toBe(0);
     expect(candidates).toContain("No alternatives were recorded for this step.");
    }
    expect(await page.locator(".pc-trace__token-name").innerText()).toContain(scenario==="root-only"?"1 attempt":"1 subtask");
    expect(await page.locator(".pc-trace__token-name").innerText()).not.toContain("plan + review");
    expect(await page.locator(".pc-trace__card").first().innerText()).toContain("Planning and review tokens: Not recorded");
   }
   else if(scenario==="null-proposal"){await page.locator(".pc-trace__steps").waitFor();expect(await page.locator(".pc-trace__steps").innerText()).toContain("Dispatch decision recorded");expect(await page.locator(".pc-trace__candidates").innerText()).toContain("No alternatives were recorded for this step.");expect(await page.locator(".pc-trace__candidates").innerText()).not.toContain("capable with spare capacity");}
   else if(scenario==="running"){await page.locator(".pc-trace").waitFor();expect(await page.getByRole("button",{name:"Accept result"}).count()).toBe(0);}
   else{await page.getByRole("alert").waitFor();expect(await page.getByRole("alert").innerText()).toContain(scenario==="error"?"Task read failed":"Trace read failed");}
   await page.close();
  }
 }finally{await browser.close();}
},30000);


browserTest('running task page does not poll task detail or session while idle',async()=>{
 const result=await Bun.build({entrypoints:['test/fixtures/trace-browser.tsx'],target:'browser',format:'esm',tsconfig:'app/tsconfig.json'});
 expect(result.success).toBe(true);
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try {
  const page=await browser.newPage();
  await page.route('http://pacer.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto('http://pacer.test/?scenario=running#/tasks/trace-root');
  await page.addScriptTag({type:'module',content:await result.outputs[0]!.text()});
  await page.locator('.pc-trace').waitFor();
  await page.waitForTimeout(500);
  const before=await page.evaluate(()=>(window as any).traceCalls.length);
  await page.clock.install();
  await page.clock.runFor(30000);
  const calls=await page.evaluate(()=>(window as any).traceCalls as string[]);
  expect(calls.length-before).toBeLessThanOrEqual(5);
  expect(calls.filter(op=>op==='task.get')).toHaveLength(1);
  expect(calls.filter(op=>op==='task.session')).toHaveLength(1);
 } finally {await browser.close();}
},30000);
