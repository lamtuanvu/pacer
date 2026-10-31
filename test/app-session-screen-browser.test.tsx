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
async function openSession(browser: Browser, scenario: Scenario, viewport = { width: 1440, height: 900 }, colorScheme: "light" | "dark" = "light", tokenMode?: string, navigator = false, diffError?: string) {
  const { source, css } = await sessionScreen();
  const page = await browser.newPage({ viewport, colorScheme });
  await page.route("http://pacer.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>session</title><div id="app"></div>' }));
  await page.goto("http://pacer.test/#/tasks/t-0412");
  await page.evaluate(error => { (window as any).DIFF_ERROR = error; }, diffError);
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
    expect(await end.evaluate(node => node.getBoundingClientRect().height)).toBe(32);
    expect(await page.locator("h1").count()).toBe(1);
    expect(await page.locator(".pc-topbar h1").textContent()).toBe(await page.locator(".pc-session-bar h2").textContent());
    expect(await page.locator(".pc-session-bar h2").evaluate(node => [getComputedStyle(node).fontSize,getComputedStyle(node).fontWeight])).toEqual(["14px","650"]);
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
 const long=panel.locator('[title$="demo-stages-frames.md"]');
 expect(await long.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
 expect(await panel.getByRole('heading',{name:'Changes · 3 files',exact:true}).count()).toBe(1);
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
 await page.locator(".pc-session-bar").getByRole("button",{name:"Review result",exact:true}).click();
 expect(page.url()).toContain("#/tasks/t-0412/review");
 await page.getByRole("button",{name:"Toggle details panel"}).click();
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
 expect(await page.locator(".pc-session-bar h2").evaluate(node=>getComputedStyle(node).textOverflow)).toBe("ellipsis");
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

async function assertTitleBarFits(page: Page) {
  const geometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const title = box("h1.pc-topbar__heading"), search = box("[data-command-trigger]");
    const delegate = [...document.querySelectorAll(".pc-topbar a")].find(node => node.textContent === "New task")!.getBoundingClientRect();
    return { scroll: document.scrollingElement!.scrollWidth, width: innerWidth, title: title.width, search: search.width, searchRight: search.right, delegate: delegate.right };
  });
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
  expect(geometry.title).toBeGreaterThanOrEqual(80);
  expect(geometry.search).toBeGreaterThan(0);
  expect(geometry.searchRight).toBeLessThanOrEqual(geometry.width);
  expect(geometry.delegate).toBeLessThanOrEqual(geometry.width);
  await expect(page.locator("[data-command-trigger]").isVisible()).resolves.toBe(true);
}

browserTest("session_title_bar_keeps_title_search_and_delegate_reachable", async () => withBrowser(async browser => {
  for (const scenario of ["conversation", "supervised", "ended"] as const) for (const width of [1440, 1100, 768, 375]) {
    const page = await openSession(browser, scenario, { width, height: 900 });
    await assertTitleBarFits(page);
    if (width === 1440) {
      expect(await page.locator("h1.pc-topbar__heading").evaluate(node => {
        const style = getComputedStyle(node);
        return [style.fontSize, style.lineHeight, style.fontWeight];
      })).toEqual(["14px", "20px", "650"]);
      expect(await page.locator(".pc-planner__name").innerText()).toBe("Claude Code");
      expect(await page.locator(".pc-planner__name").evaluate(node => ({ wrap: getComputedStyle(node).whiteSpace, height: node.getBoundingClientRect().height }))).toMatchObject({ wrap: "nowrap", height: 19 });
      expect(await page.locator("h1.pc-topbar__heading").evaluate(node => getComputedStyle(node).textOverflow)).toBe("ellipsis");
      expect(await page.locator(".pc-planner").evaluate(node => node.getBoundingClientRect().height)).toBe(24);
    }
    await page.close();
  }
}), 60_000);

browserTest("session_workspace_fits_between_frame_bars", async () => withBrowser(async browser => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }]) {
    const page = await openSession(browser, "conversation", viewport);
    const geometry = await page.evaluate(() => ({
      scroll: document.scrollingElement!.scrollHeight, height: innerHeight,
      footer: document.querySelector(".pc-conversation-footer")!.getBoundingClientRect().bottom,
      status: document.querySelector(".pc-statusbar")!.getBoundingClientRect().top,
    }));
    expect(geometry.scroll).toBe(geometry.height);
    expect(geometry.footer).toBeLessThanOrEqual(geometry.status);
    await page.close();
  }
}), 30_000);


browserTest("sessions navigator matches board geometry and retains panel focus", async () => withBrowser(async browser => {
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await openSession(browser, "conversation", { width: 1440, height: 900 }, colorScheme);
    const panel = page.getByRole("complementary", { name: "Sessions", exact: true });
    const hide = panel.getByRole("button", { name: "Hide Sessions" });
    const geometry = await panel.evaluate(node => {
      const nav = node.querySelector(".pc-task-nav")!, head = node.querySelector(".pc-task-nav__head")!;
      const card = node.querySelector(".pc-session-node-group")!, scroll = node.querySelector(".pc-task-nav__scroll")!;
      return { width: node.getBoundingClientRect().width, cardX: card.getBoundingClientRect().x, cardWidth: card.getBoundingClientRect().width,
        headTop: head.getBoundingClientRect().top, headHeight: head.getBoundingClientRect().height, headPadding: getComputedStyle(head).padding,
        listPadding: getComputedStyle(scroll).padding, navBorder: getComputedStyle(nav).borderRightWidth,
        barCount: node.querySelectorAll(".pc-side-panel__bar").length,
        toggleInHead: !!head.querySelector('[aria-label="Hide Sessions"]') };
    });
    expect(geometry).toEqual({ width: 272, cardX: 60, cardWidth: 256, headTop: 36, headHeight: 38, headPadding: "0px 8px 0px 14px",
      listPadding: "0px 8px 12px", navBorder: "0px", barCount: 0, toggleInHead: true });
    await expect(hide.getAttribute("aria-expanded")).resolves.toBe("true");
    await expect(hide.getAttribute("aria-controls")).resolves.toBe("pc-side-panel-left");
    await expect(panel.locator('.pc-session-node__meta>.mono').first().getAttribute("title")).resolves.toBe("acme/api");
    const selected = panel.locator('.pc-session-node[aria-current=page]');
    expect(await selected.locator('.pc-session-node__title strong').evaluate(node => getComputedStyle(node).fontWeight)).toBe("600");
    expect(await selected.evaluate(node => (() => { const sample = document.createElement("span"); sample.style.background = "var(--surface-page)"; node.append(sample); const matches = getComputedStyle(node).backgroundColor === getComputedStyle(sample).backgroundColor; sample.remove(); return matches; })())).toBe(true);
    await hide.focus(); await page.keyboard.press("Enter");
    await focused(page, '[aria-label="Show Sessions"]');
    const show = page.getByRole("button", { name: "Show Sessions" });
    await expect(show.getAttribute("aria-expanded")).resolves.toBe("false");
    await expect(show.getAttribute("aria-controls")).resolves.toBe(null);
    expect(await page.locator('.pc-side-panel--left').evaluate(node => node.getBoundingClientRect().width)).toBe(40);
    await page.keyboard.press("Enter");
    await focused(page, '[aria-label="Hide Sessions"]');
    // Collapsing while a row has focus moves focus into the retained closed strip.
    await panel.locator('[aria-current="page"]').focus();
    await page.keyboard.press("ControlOrMeta+b");
    await focused(page, '[aria-label="Show Sessions"]');
    await page.keyboard.press("Enter");
    await focused(page, '[aria-label="Hide Sessions"]');
    // The persistent frame control continues to work and keeps focus.
    const frameToggle = page.getByRole("button", { name: "Toggle left panel" });
    await frameToggle.click();
    await expect(panel.count()).resolves.toBe(0);
    await focused(page, '[aria-label="Toggle left panel"]');
    await frameToggle.click();
    await panel.waitFor();
    await page.close();
  }
}), 30_000);

browserTest("narrow_desktop_starts_with_the_side_panels_closed", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation", { width: 900, height: 900 });
  // First visit below 1100px: the session keeps the room; the toggles still open both panels.
  expect(await page.locator("aside").count()).toBe(0);
  expect((await page.locator(".pc-task-workspace__main").boundingBox())!.width).toBeGreaterThan(450);
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  await page.getByRole("complementary", { name: "Session details" }).waitFor();
  await page.close();
}), 30_000);


browserTest("no_actions_on_ended_session", async () => withBrowser(async browser => {
  const page = await openSession(browser, "ended");
  const actions = page.locator(".pc-frame-actions");
  // Session mutations disappear from the top bar; result navigation stays in the session header.
  await expect(page.locator(".pc-session-bar").getByRole("button", { name: "Review result", exact: true }).count()).resolves.toBe(1);
  await expect(actions.getByRole("button").count()).resolves.toBe(0);
  await expect(page.getByRole("button", { name: "Toggle details panel" }).count()).resolves.toBe(1);
  for (const name of ["End session", "Stop", "Take over", "Resume conversation", "Open in terminal"]) await expect(page.getByRole("button", { name, exact: true }).count()).resolves.toBe(0);
  // The task's title shows in the title bar (the frame hides the route's own heading).
  await expect(page.locator(".pc-topbar").getByRole("heading", { level: 1 }).isVisible()).resolves.toBe(true);
  // The terminal fills the centre without a view switch.
  await expect(page.locator(".pc-task-workspace__main>.pc-session>.pc-tabs").count()).resolves.toBe(0);
  // Ended results show their outcome in Details.
  await expect(page.getByRole("complementary", { name: "Session details" }).getByRole("heading", { name: "Result" }).count()).resolves.toBe(1);
  await page.close();
}), 20_000);

browserTest("session_details_toggle_keyboard_and_focus", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation");
  const panel = page.getByRole("complementary", { name: "Session details" });
  const hide = page.getByRole("button", { name: "Toggle details panel" });
  await expect(hide.getAttribute("aria-pressed")).resolves.toBe("true");
  await expect(page.locator("#pc-side-panel-right").count()).resolves.toBe(1);
  // Keyboard activation keeps focus on the persistent title-bar toggle.
  await hide.focus();
  await page.keyboard.press("Enter");
  await expect(panel.count()).resolves.toBe(0);
  await expect(hide.getAttribute("aria-pressed")).resolves.toBe("false");
  await focused(page, '[aria-label="Toggle details panel"]');
  expect(await page.evaluate(() => localStorage.getItem("pacer.panel.session-details"))).toBe("0");
  // Ctrl-Shift-B toggles it from anywhere outside a text field.
  await page.locator("#main-content").focus();
  await page.keyboard.press("Control+Shift+B");
  await panel.waitFor();
  // The panel tabs follow the shared keyboard contract and point at their tabpanel.
  await panel.getByRole("tab", { name: "Details" }).focus();
  await page.keyboard.press("ArrowLeft");
  await focused(page, '[role="tab"][aria-selected="true"]');
  const tab = panel.getByRole("tab", { name: "Changes 3", exact: true });
  await expect(tab.getAttribute("aria-selected")).resolves.toBe("true");
  const controls = await tab.getAttribute("aria-controls");
  await expect(page.locator(`#${controls}`).getAttribute("aria-labelledby")).resolves.toBe(await tab.getAttribute("id"));
  // Ctrl-b collapses the Sessions list and keeps the session usable.
  await page.locator("#main-content").focus();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByRole("complementary", { name: "Sessions" }).count()).resolves.toBe(0);
  await expect(page.getByRole("button", { name: "Show Sessions" }).getAttribute("aria-expanded")).resolves.toBe("false");
  await page.close();
}), 20_000);

browserTest("narrow_session_keeps_details_in_page", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation", { width: 375, height: 812 });
  await expect(page.getByRole("complementary").count()).resolves.toBe(0);
  const details = page.getByRole("region", { name: "Session details" });
  await details.getByRole("tab", { name: "Changes 3", exact: true }).waitFor();
  await expect(page.getByRole("button", { name: "End session" }).isVisible()).resolves.toBe(true);
  // No details toggle without a panel to toggle.
  await expect(page.getByRole("button", { name: /session details/ }).count()).resolves.toBe(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth)).toBe(true);
  await page.close();
}), 20_000);

const callsOf = (page: Page, op: string) => page.evaluate(op => (window as any).CALLS.filter((call: { op: string }) => call.op === op), op);

browserTest("closed_panel_keeps_next_step_reachable", async () => withBrowser(async browser => {
  const page = await openSession(browser, "ended");
  const actions = page.locator(".pc-session-bar");
  // Dedicated result navigation remains reachable with either panel state.
  await expect(actions.getByRole("button", { name: "Review result" }).count()).resolves.toBe(1);
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  const next = actions.getByRole("button", { name: "Review result" });
  await expect(next.getAttribute("class")).resolves.toContain("pc-btn--secondary");
  await next.focus();
  await page.keyboard.press("Enter");
  expect(page.url()).toContain("#/tasks/t-0412/review");
  await page.getByRole("button", { name: "Toggle details panel" }).click();
  const panel = page.getByRole("complementary", { name: "Session details" });
  await panel.waitFor();
  await expect(panel.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).resolves.toBe("true");
  await expect(panel.getByRole("button", { name: "Mark accepted" }).isVisible()).resolves.toBe(true);
  await expect(actions.getByRole("button", { name: "Review result" }).count()).resolves.toBe(1);
  const failed = await openSession(browser, "failed");
  await failed.evaluate(() => { location.hash += "?repo=repo&scope=all"; });
  await failed.locator(".pc-session-bar").getByRole("button", { name: "Review result", exact: true }).click();
  expect(failed.url()).toContain("#/tasks/t-0412/failure?repo=repo&scope=all");
  await failed.close();
  // A running session has no next step to surface, even with the panel closed.
  const running = await openSession(browser, "supervised");
  await running.getByRole("button", { name: "Toggle details panel" }).click();
  await expect(running.locator(".pc-session-bar").getByRole("button", { name: "Review result" }).count()).resolves.toBe(0);
  await page.close(); await running.close();
}), 30_000);

browserTest("stop_shortcut_confirms_and_only_exists_while_running", async () => withBrowser(async browser => {
  const page = await openSession(browser, "supervised");
  await page.locator("#main-content").focus();
  await page.keyboard.press("s");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await expect(dialog.innerText()).resolves.toContain("Stop this session and its executor?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  expect(await callsOf(page, "task.stop")).toHaveLength(0);
  await page.keyboard.press("s");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Stop" }).click();
  await page.waitForFunction(() => (window as any).CALLS.some((call: { op: string }) => call.op === "task.stop"));
  // Ended: the shortcut is gone with the action (UI-13).
  await page.getByRole("button", { name: "End session" }).waitFor({ state: "detached" });
  await page.locator("#main-content").focus();
  await page.keyboard.press("s");
  await page.waitForTimeout(150);
  await expect(page.getByRole("dialog").count()).resolves.toBe(0);
  await page.close();
}), 30_000);

browserTest("retry_asks_for_an_executor_and_sends_the_current_revision", async () => withBrowser(async browser => {
  const page = await openSession(browser, "ended");
  const panel = page.getByRole("complementary", { name: "Session details" });
  await panel.getByRole("button", { name: "Retry session…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  // The unavailable executor is offered with its reason, never selectable as the default.
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await page.waitForFunction(() => (window as any).CALLS.some((call: { op: string }) => call.op === "task.retry"));
  const [call] = await callsOf(page, "task.retry");
  expect(call.params).toMatchObject({ id: "t-0412", executor: "codex", expect_rev: 3 });
  // Retry opens the new attempt's task.
  await page.waitForFunction(() => location.hash.includes("t-retried"));
  await page.close();
}), 30_000);

browserTest("takeover_starts_from_the_page_and_ended_sessions_offer_none", async () => withBrowser(async browser => {
  const page = await openSession(browser, "supervised");
  const take = page.getByRole("main").getByRole("button", { name: "Take over" });
  await expect(take.isEnabled()).resolves.toBe(true);
  await take.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (window as any).CALLS.some((call: { op: string }) => call.op === "task.takeover"));
  expect(await callsOf(page, "task.takeover")).toHaveLength(1);
  await page.close();
  const ended = await openSession(browser, "ended");
  await expect(ended.getByRole("button", { name: "Take over" }).count()).resolves.toBe(0);
  await ended.close();
}), 30_000);


browserTest("session_status_pill_retains_tone_and_reduced_motion", async () => withBrowser(async browser => {
  for (const scenario of ["supervised", "ended"] as const) {
    const page = await openSession(browser, scenario);
    const dot = page.locator(".pc-session-bar .pc-glyph");
    const expected = await page.evaluate(tone => {
      const node = document.createElement("span"); node.style.color = `var(--${tone}-fg)`; document.body.append(node);
      const color = getComputedStyle(node).color; node.remove(); return color;
    }, scenario === "supervised" ? "info" : "good");
    expect(await dot.evaluate(node => getComputedStyle(node).color)).toBe(expected);
    expect(await dot.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await dot.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
    await page.close();
  }
}), 30_000);


browserTest("details workspace and brief wrap repository labels without horizontal scroll", async () => withBrowser(async browser => {
  const page = await openSession(browser, "conversation");
  const panel = page.getByRole("complementary", { name: "Session details" });
  await panel.getByRole("heading", { name: "Workspace", exact: true }).waitFor();
  const caption=page.locator('.pc-session-bar__caption');
  expect(await caption.innerText()).toBe("acme/api · pacer/review");
  expect(await caption.evaluate(node=>getComputedStyle(node).textOverflow)).toBe("ellipsis");
  expect(await caption.evaluate(node=>getComputedStyle(node).fontFamily)).toContain("mono");
  const repo = panel.locator(".pc-session-workspace dd").first();
  expect(await repo.innerText()).toBe("acme/api");
  expect(await panel.locator(".pc-session-repository").count()).toBe(0);
  for (const value of [repo]) {
    expect(await value.evaluate(node => getComputedStyle(node).overflowWrap)).toBe("anywhere");
    // Exercise an unbroken repository label wider than the panel without changing fixture data.
    expect(await value.evaluate(node => { node.textContent = "repository/".repeat(40); return node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().height > 18; })).toBe(true);
  }
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const sections = await panel.locator(".pc-session-details section").evaluateAll(nodes => nodes.map(node => ({ title: node.querySelector("h3")?.textContent, border: getComputedStyle(node).borderTopWidth, padding: getComputedStyle(node).paddingTop })));
  expect(sections[0]).toMatchObject({ title: "Workspace", border: "0px", padding: "0px" });
  for (const section of sections.slice(1)) expect(section).toMatchObject({ border: "1px", padding: "14px" });
  const why = panel.locator(".pc-session-details section").filter({ has: page.getByRole("heading", { name: /^Why / }) });
  expect(await why.locator("p").evaluate(node => ({ top: getComputedStyle(node).marginTop, bottom: getComputedStyle(node).marginBottom,
    gap: node.getBoundingClientRect().top - node.previousElementSibling!.getBoundingClientRect().bottom }))).toEqual({ top: "0px", bottom: "0px", gap: 6 });
  const tokenSection = panel.locator("section").filter({ has: page.getByRole("heading", { name: "Tokens, live", exact: true }) });
  expect(await tokenSection.locator(".pc-session-token-value").evaluate(node => ({ top: getComputedStyle(node).marginTop, bottom: getComputedStyle(node).marginBottom,
    gap: node.getBoundingClientRect().top - node.previousElementSibling!.getBoundingClientRect().bottom }))).toEqual({ top: "0px", bottom: "0px", gap: 6 });
  expect(await tokenSection.locator("dt").allTextContents()).toEqual([]);
  const command = panel.locator(".pc-session-acceptance");
  expect(await command.evaluate(node => ({ font: getComputedStyle(node).fontSize, padding: getComputedStyle(node).padding, radius: getComputedStyle(node).borderRadius }))).toEqual({ font: "12px", padding: "6px 8px", radius: "6px" });
  await page.close();
}), 20_000);



browserTest("session header keeps full status ahead of clipped repository facts",async()=>withBrowser(async browser=>{
 for(const scenario of ["conversation","supervised","failed","ended"] as const)for(const width of [1440,1100,1000,999,768,375]){
  const page=await openSession(browser,scenario,{width,height:900});
  await assertTitleBarFits(page);
  const status=page.locator('.pc-session-bar .pc-pill');
  expect(await status.isVisible()).toBe(true);
  expect(await status.innerText()).toContain(scenario==='supervised'?'Working':scenario==='failed'?'Failed':scenario==='ended'?'Completed':'Working');
  if(width>=768){
   const caption=page.locator('.pc-session-bar__caption');
   await caption.evaluate(node=>{node.textContent='acme/api · feature/very-long-session-branch-name/'.repeat(8)});
   expect(await caption.evaluate(node=>getComputedStyle(node).textOverflow)).toBe('ellipsis');
   await status.evaluate(node=>{node.textContent='Needs your answer'});
   expect(await status.evaluate(node=>node.scrollWidth<=node.clientWidth&&node.getBoundingClientRect().right<=node.closest('.pc-session-bar')!.getBoundingClientRect().right)).toBe(true);
  }
  expect(await page.evaluate(()=>document.scrollingElement!.scrollWidth<=innerWidth)).toBe(true);
  await page.close();
 }
}),60000);

browserTest("unavailable Changes keeps raw errors private and never claims an empty successful diff", async () => withBrowser(async browser => {
  const raw = "cannot diff: fatal: cannot change to '/private/fixture/worktree': No such file or directory";
  const page = await openSession(browser, "failed", undefined, "light", undefined, false, raw);
  const panel = page.getByRole("complementary", {name:"Session details"});
  await panel.getByRole("tab", {name:/^Changes(?: 0)?$/}).click({timeout: 3000});
  const alerts = await panel.getByRole("alert").allTextContents();
  expect(alerts.join(" ")).not.toContain("cannot diff:");
  expect(alerts.length).toBeGreaterThan(0);
  expect(await panel.innerText()).not.toContain("/private/fixture/worktree");
  expect(await panel.getByText("No changes so far.", {exact:true}).count()).toBe(0);
  expect(await panel.getByRole("tab", {name:"Changes 0",exact:true}).count()).toBe(0);
  await panel.getByRole("tab", {name:"Details",exact:true}).click();
  expect(await panel.getByText("No changes so far.", {exact:true}).count()).toBe(0);
  expect(await panel.getByRole("heading", {name:"Changes · 0 files",exact:true}).count()).toBe(0);
  await page.close();
}), 30000);
