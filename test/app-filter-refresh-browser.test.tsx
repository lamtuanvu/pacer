import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { mkdir } from "node:fs/promises";
const executablePath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!executablePath);
let browser: Browser, server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  if (!executablePath) return;
  const built = await Bun.build({entrypoints:["test/fixtures/ui/filter-refresh-browser.tsx"],target:"browser"});
  if (!built.success) throw new AggregateError(built.logs);
  const script = await built.outputs[0]!.text();
  const css = (await Promise.all(["app/src/ds/tokens.css","app/src/ds/components.css","app/src/ds/feedback.css","app/src/styles.css","app/src/screens/insights/insights.css","app/src/screens/session/session.css"].map(path=>Bun.file(path).text()))).join("\n");
  server = Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response(`<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script type="module">${script}</script>`,{headers:{"Content-Type":"text/html"}})});
  browser = await chromium.launch({executablePath,headless:true});
});
afterAll(async()=>{await browser?.close();server?.stop(true);});

for (const screen of ["dispatch","insights","tasks"]) browserTest(`${screen} retains rendered content while a period/repo request is pending`,async()=>{
  const page = await browser.newPage({viewport:{width:1440,height:900},colorScheme:"dark",reducedMotion:"reduce"});
  const errors: string[] = [];
  page.on("pageerror",error=>errors.push(error.message));
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${server.url}#/${screen === "dispatch" ? "" : screen}`);
    const content = page.locator(screen === "dispatch" ? "#glance" : screen === "insights" ? ".pc-insights__kpi" : ".pc-tasks-page__tree").first();
    await content.waitFor();
    await page.waitForFunction(()=>!document.body.innerText?.includes("Loading figures…") && !document.body.innerText?.includes("Loading insights…") && !document.body.innerText?.includes("Loading tasks…"));
    await page.waitForTimeout(250);
    expect(errors).toEqual([]);
    const values = screen === "dispatch" ? content.locator(".pc-glance__value") : screen === "insights" ? content.locator("strong") : content;
    const before = await values.allTextContents();
    const bounds = await content.boundingBox();
    await page.evaluate(()=>{(window as any).refreshFixture.hold=true;});
    if (screen !== "tasks") await page.getByRole("group",{name:"Period"}).getByRole("button",{name:screen === "dispatch" ? "Today" : "30 days",exact:true}).click();
    else await page.evaluate(()=>{location.hash = "#/tasks?repo=second";});
    expect(await values.allTextContents()).toEqual(before);
    await page.waitForFunction(()=>document.querySelector('[aria-busy="true"]'));
    expect(await values.allTextContents()).toEqual(before);
    expect(await content.boundingBox()).toEqual(bounds);
    if (screen === "dispatch" && process.env.PACER_ICON_FLASH_EVIDENCE) {
      await mkdir(".work/fixtures/review-icons-flash",{recursive:true});
      await page.screenshot({path:".work/fixtures/review-icons-flash/dispatch-mid-switch-dark.png"});
      await page.locator(".pc-rail").screenshot({path:".work/fixtures/review-icons-flash/rail-dark.png"});
    }
    await page.evaluate(()=>{(window as any).refreshFixture.hold=false;(window as any).refreshFixture.release();});
    await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
    if (screen !== "tasks") expect(await values.allTextContents()).not.toEqual(before);
    if (screen !== "tasks") expect(await content.boundingBox()).toEqual(bounds);
    // Repeat for repository changes, including the already-cached return path.
    const last = await values.allTextContents();
    await page.evaluate(screen=>{(window as any).refreshFixture.hold=true;location.hash=`#/${screen === "dispatch" ? "" : screen}?repo=third`;},screen);
    await page.waitForFunction(()=>document.querySelector('[aria-busy="true"]'));
    expect(await values.allTextContents()).toEqual(last);
    await page.evaluate(()=>{(window as any).refreshFixture.hold=false;(window as any).refreshFixture.release();});
    await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
    expect(errors).toEqual([]);
  } finally {await page.close();}
});

browserTest("Dispatch keeps its ledger until every new work page arrives and exposes failed figure refreshes", async()=>{
 const page = await browser.newPage({viewport:{width:1440,height:900}});
 page.setDefaultTimeout(5000);
 try {
  await page.goto(String(server.url));
  const ledger=page.locator('.pc-dispatch-ledger');
  await ledger.waitFor();
  await page.waitForTimeout(250);
  const rows=await ledger.innerText();
  await page.evaluate(()=>{(window as any).refreshFixture.holdOlder=true;location.hash="#/?repo=third";});
  await page.waitForFunction(()=>(window as any).refreshFixture.pending.some((item:any)=>item.before));
  expect(await ledger.innerText()).toBe(rows);
  expect(await page.getByText("Loading dispatch…",{exact:true}).count()).toBe(0);
  await page.evaluate(()=>{(window as any).refreshFixture.holdOlder=false;(window as any).refreshFixture.release();});
  await page.waitForTimeout(100);
  const values=await page.locator('.pc-glance__value').allTextContents();
  await page.evaluate(()=>{(window as any).refreshFixture.hold=true;});
  await page.getByRole("group",{name:"Period"}).getByRole("button",{name:"30 days",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-busy="true"]'));
  await page.evaluate(()=>{(window as any).refreshFixture.fail=true;(window as any).refreshFixture.release();});
  await page.getByRole("alert").filter({hasText:"Could not refresh figures"}).waitFor();
  expect(await page.locator('.pc-glance__value').allTextContents()).toEqual(values);
  expect(await page.getByRole("button",{name:"Try again",exact:true}).count()).toBeGreaterThan(0);
 } finally {await page.close();}
});

browserTest("fast period reads avoid refresh feedback and reduced motion adds no transition",async()=>{
 const page=await browser.newPage({reducedMotion:"reduce"});
 try{
  await page.goto(String(server.url));
  await page.locator('#glance .pc-glance__value').first().waitFor();
  await page.waitForTimeout(250);
  await page.evaluate(()=>{
   (window as any).busyChanges=[];
   new MutationObserver(records=>{for(const record of records)if((record.target as Element).getAttribute('aria-busy')==='true')(window as any).busyChanges.push(true);}).observe(document.getElementById('glance')!,{attributes:true,attributeFilter:['aria-busy']});
  });
  await page.getByRole('group',{name:'Period'}).getByRole('button',{name:'30 days',exact:true}).click();
  await page.waitForTimeout(250);
  expect(await page.evaluate(()=>(window as any).busyChanges)).toEqual([]);
  expect(await page.locator('#glance').evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s');
 }finally{await page.close();}
});
