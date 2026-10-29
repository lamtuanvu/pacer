import { expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { generateTokensCss, readTokens } from "../app/tokens-gen";

// Run with PACER_TEST_BROWSER pointing to a local Chromium/Chrome executable; without it these checks skip.
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
type Scenario = "conversation" | "supervised" | "ended" | "failed";

let built: Promise<{ source: string; css: string }> | undefined;
function sessionScreen() {
  return built ??= (async () => {
    const build = await Bun.build({ entrypoints: ["test/fixtures/session-screen-browser.tsx"], target: "browser", splitting: false, plugins: [{ name: "stub-pty-view", setup(builder) {
      builder.onResolve({ filter: /term\/LazyTerminal$/ }, () => ({ path: "stub", namespace: "terminal-stub" }));
      builder.onLoad({ filter: /.*/, namespace: "terminal-stub" }, () => ({ contents: "import { h } from 'preact'; export const LazyTerminal = () => h('div', { className: 'pc-terminal-stub', tabIndex: 0, 'aria-label': 'Agent terminal' });", loader: "js" }));
    } }] });
    expect(build.success).toBe(true);
    const css = [generateTokensCss(readTokens("app/src/ds")), ...await Promise.all(["app/src/ds/components.css", "app/src/ds/feedback.css", "app/src/styles.css", "app/src/screens/session/session.css", "app/src/screens/terminal/terminal.css", "app/src/screens/work/work.css"].map(path => Bun.file(path).text()))].join("\n");
    return { source: await build.outputs[0]!.text(), css };
  })();
}
async function openSession(browser: Browser, scenario: Scenario, viewport = { width: 1440, height: 900 }, colorScheme: "light" | "dark" = "light", tokenMode?: string, navigator = false) {
  const { source, css } = await sessionScreen();
  const page = await browser.newPage({ viewport, colorScheme });
  await page.route("http://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>session</title><div id="app"></div>' }));
  await page.goto("http://pacer.test/#/tasks/t-0412");
  await page.evaluate(([css, scenario, tokenMode, navigator]) => { document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`); (window as any).SCENARIO = scenario; (window as any).TOKEN_MODE = tokenMode; (window as any).NAVIGATOR = navigator; }, [css, scenario, tokenMode, navigator] as const);
  await page.evaluate(async code => { const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" })); await import(url); URL.revokeObjectURL(url); }, source);
  await page.locator(".pc-session-bar").first().waitFor({ state: "attached" });
  return page;
}
const focused = (page: Page, selector: string) => page.waitForFunction(at => document.activeElement?.matches(at), selector, { timeout: 2000 })
  .catch(async error => { throw new Error(`${error.message}; focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))}`); });
const calls = (page: Page) => page.evaluate(() => (window as any).CALLS.map((call: { op: string }) => call.op) as string[]);
async function withBrowser(run: (browser: Browser) => Promise<void>) {
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  try { await run(browser); } finally { await browser.close(); }
}

browserTest("session header confirms end, preserves resume, and keeps the global bar clear", async () => withBrowser(async browser => {
  for (const scenario of ["conversation", "supervised"] as const) {
    const page = await openSession(browser, scenario);
    const end = page.locator(".pc-session-bar").getByRole("button", {name:"End session"});
    expect(await end.evaluate(node => node.getBoundingClientRect().height)).toBe(26);
    expect(await page.locator(".pc-session-bar h1").evaluate(node => [getComputedStyle(node).fontSize,getComputedStyle(node).fontWeight])).toEqual(["14px","650"]);
    expect(await page.locator(".pc-topbar").getByRole("button",{name:"End session"}).count()).toBe(0);
    await end.click(); await page.getByRole("dialog").getByRole("button",{name:"Cancel"}).click();
    expect(await calls(page)).not.toContain(scenario === "conversation" ? "session.end" : "task.stop");
    await end.click(); await page.getByRole("dialog").getByRole("button",{name:scenario === "conversation" ? "End session" : "Stop",exact:true}).click();
    await end.waitFor({state:"detached"});
    await focused(page,".pc-session-bar a");
    expect(await calls(page)).toContain(scenario === "conversation" ? "session.end" : "task.stop");
    if (scenario === "conversation") {
      const resume=page.getByRole("button",{name:"Resume conversation"}); await resume.waitFor(); await resume.click();
      await page.waitForFunction(()=>(window as any).CALLS.some((call:any)=>call.op==='session.resume'));
    }
    await page.close();
  }
}),60000);

browserTest("session Changes lists files with review links and keeps attachments reachable",async()=>withBrowser(async browser=>{
 const page=await openSession(browser,"conversation");
 const panel=page.getByRole("complementary",{name:"Session details"});
 await panel.getByRole("tab",{name:"Changes 3",exact:true}).click();
 const files=panel.locator(".pc-changed-files__row");await files.first().waitFor();expect(await files.count()).toBe(3);
 expect(await files.allInnerTexts()).toEqual([expect.stringContaining("src/example.ts"),expect.stringContaining("demo-stages-frames.md"),expect.stringContaining("new")]);
 expect(await panel.getByRole("link",{name:"Open diff"}).getAttribute("href")).toBe("#/tasks/t-0412/review");
 expect(await panel.getByRole("heading",{name:"Files",exact:true}).count()).toBe(1);
 expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
 await page.close();
}),30000);

browserTest("session panel toggles, keyboard tabs, navigator collapse and narrow layout work",async()=>withBrowser(async browser=>{
 const page=await openSession(browser,"conversation");
 const toggle=page.getByRole("button",{name:"Toggle details panel"});await toggle.click();
 expect(await page.getByRole("complementary",{name:"Session details"}).count()).toBe(0);
 await page.locator("#main-content").focus();await page.keyboard.press("Control+Shift+B");
 const panel=page.getByRole("complementary",{name:"Session details"});await panel.waitFor();
 await panel.getByRole("tab",{name:"Details",exact:true}).focus();await page.keyboard.press("ArrowRight");
 expect(await panel.getByRole("tab",{name:"Changes 3",exact:true}).getAttribute("aria-selected")).toBe("true");
 await page.getByRole("button",{name:"Hide Sessions",exact:true}).click();await focused(page,'[aria-label="Show Sessions"]');
 await page.keyboard.press("Enter");await page.getByRole("complementary",{name:"Sessions",exact:true}).waitFor();
 expect(await page.locator(".pc-session-node-group").count()).toBeGreaterThan(0);
 expect(await page.locator(".pc-task-card").count()).toBe(0);
 await page.close();
 const narrow=await openSession(browser,"conversation",{width:375,height:812});
 expect(await narrow.getByRole("complementary").count()).toBe(0);
 await narrow.getByRole("region",{name:"Session details"}).getByRole("tab",{name:"Changes 3",exact:true}).waitFor();
 expect(await narrow.evaluate(()=>document.scrollingElement!.scrollWidth<=innerWidth)).toBe(true);
 expect(await narrow.getByRole("button",{name:"End session",exact:true}).isVisible()).toBe(true);
 await narrow.close();
}),40000);

browserTest("closed Details retains next step, and ended sessions retain review and retry",async()=>withBrowser(async browser=>{
 const page=await openSession(browser,"ended");expect(await page.getByRole("button",{name:"End session",exact:true}).count()).toBe(0);
 await page.getByRole("button",{name:"Toggle details panel"}).click();
 await page.getByRole("button",{name:"Review result",exact:true}).click();
 const panel=page.getByRole("complementary",{name:"Session details"});await panel.waitFor();
 expect(await panel.getByRole("button",{name:"Mark accepted",exact:true}).isVisible()).toBe(true);
 await panel.getByRole("button",{name:"Retry session…"}).click();await page.getByRole("dialog").getByRole("button",{name:"Retry",exact:true}).click();
 await page.waitForFunction(()=>(window as any).CALLS.some((c:any)=>c.op==='task.retry'));
 const call=await page.evaluate(()=>(window as any).CALLS.find((c:any)=>c.op==='task.retry'));
 expect(call.params).toMatchObject({id:"t-0412",executor:"codex",expect_rev:3});await page.close();
}),30000);

browserTest("session Details follows board order and omits Goal dump and token splits",async()=>withBrowser(async browser=>{
 for(const mode of ["mixed","partial","all-present","not-reported"]){
 const page=await openSession(browser,"supervised",{width:1440,height:900},"light",mode);
 const panel=page.getByRole("complementary",{name:"Session details"});
 const names=await panel.locator(".pc-session-details h3").allTextContents();
 expect(names.slice(0,5)).toEqual(["Workspace",expect.stringContaining("Why Codex"),"Tokens, live","Changes · 3 files","Acceptance"]);
 expect(names).not.toContain("Goal");
 expect(await panel.locator(".pc-session-token-value").innerText()).toBe(mode==='partial'?'≥ 1.2k':'1.2k');
 expect(await panel.locator(".pc-session-token-counts").count()).toBe(0);
 expect(await panel.locator(".pc-session-acceptance").innerText()).toBe("bun test");
 expect(await panel.locator(".pc-session-acceptance").evaluate(node=>[getComputedStyle(node).padding,getComputedStyle(node).borderRadius])).toEqual(["6px 8px","6px"]);
 expect(await page.locator(".pc-session-bar__caption").innerText()).toBe("acme/api · pacer/review");
 await page.close();}
}),40000);

browserTest("session title and status remain contained at desktop and phone widths",async()=>withBrowser(async browser=>{
 for(const width of [1920,1440,1100,768,375]){
 const page=await openSession(browser,"conversation",{width,height:900});
 expect(await page.evaluate(()=>document.scrollingElement!.scrollWidth<=innerWidth)).toBe(true);
 expect(await page.locator(".pc-session-bar h1").evaluate(node=>getComputedStyle(node).textOverflow)).toBe("ellipsis");
 expect(await page.locator(".pc-session-bar .pc-pill").isVisible()).toBe(true);
 expect(await page.locator("[data-command-trigger]").isVisible()).toBe(true);
 await page.close();}
}),40000);

browserTest("stop shortcut confirms, and takeover remains wired",async()=>withBrowser(async browser=>{
 const page=await openSession(browser,"supervised");
 await page.getByRole("button",{name:"Take over",exact:true}).click();await page.waitForFunction(()=>(window as any).CALLS.some((c:any)=>c.op==='task.takeover'));
 await page.locator("#main-content").focus();await page.keyboard.press("s");await page.getByRole("dialog").waitFor();
 await page.getByRole("dialog").getByRole("button",{name:"Cancel"}).click();
 expect(await calls(page)).not.toContain("task.stop");await page.close();
}),30000);

browserTest("session navigator joins live snapshot tasks with dispatch parent links",async()=>withBrowser(async browser=>{
 const page=await openSession(browser,"supervised",undefined,undefined,undefined,true);
 try {
  const navigator=page.getByRole("navigation",{name:"Task navigator"});
  const toggle=navigator.getByRole("button",{name:"2 subtasks",exact:true});
  await toggle.waitFor({timeout:2000});
  await page.waitForFunction(()=>document.querySelector(".pc-session-node__toggle")?.getAttribute("aria-expanded")==="true",{},{timeout:2000});
  expect(await toggle.getAttribute("aria-expanded")).toBe("true");
  const children=navigator.locator(".pc-session-node__children");
  expect(await children.getByRole('link').count()).toBe(2);
  expect(await children.locator('[aria-current="page"]').innerText()).toContain("Wire the parser into the report");
  expect(await children.evaluate(node=>getComputedStyle(node).borderLeftWidth)).toBe("1px");
  expect(await toggle.locator('..').locator('.pc-session-node__tokens').first().innerText()).toBe("12k");
  await toggle.click();expect(await children.count()).toBe(0);
  await toggle.click();expect(await children.count()).toBe(1);
 } finally {await page.close();}
}),30000);

browserTest("session header pill is vertically centered at both desktop sizes and themes",async()=>withBrowser(async browser=>{
 for(const viewport of [{width:1440,height:900},{width:1920,height:1080}])for(const theme of ["light","dark"] as const){
  const page=await openSession(browser,"supervised",viewport,theme);
  try {
   const geometry=await page.locator('.pc-session-bar').evaluate(bar=>{
    const pill=bar.querySelector('.pc-pill')!,b=bar.getBoundingClientRect(),p=pill.getBoundingClientRect();
    return {height:b.height,offset:Math.abs((p.top+p.height/2)-(b.top+(b.height-1)/2)),align:getComputedStyle(pill).alignSelf};
   });
   expect(geometry.height).toBe(40);expect(geometry.align).toBe("center");expect(geometry.offset).toBeLessThanOrEqual(0.5);
  } finally {await page.close();}
 }
}),30000);
