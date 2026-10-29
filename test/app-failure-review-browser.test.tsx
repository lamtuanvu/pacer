import {expect, test} from "bun:test";
import {chromium, type Browser} from "playwright-core";
import {generateTokensCss, readTokens} from "../app/tokens-gen";
const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
async function open(browser:Browser, settings:unknown) {
  const build = await Bun.build({entrypoints:["test/fixtures/failure-review-browser.tsx"],target:"browser"});
  expect(build.success).toBe(true);
  const page = await browser.newPage();
  page.on("pageerror",error=>console.error(error.stack));
  await page.route("http://pacer.test/**",route=>route.fulfill({contentType:"text/html",body:'<div id="app"></div>'}));
  await page.goto("http://pacer.test/");
  await page.evaluate(settings => {(window as any).SETTINGS=settings;},settings);
  await page.addScriptTag({content:await build.outputs[0]!.text(),type:"module"});
  await page.addStyleTag({content:[generateTokensCss(readTokens("app/src/ds")),await Bun.file("app/src/ds/components.css").text(),await Bun.file("app/src/screens/review/result-page.css").text()].join("\n")});
  await page.locator(".pc-result-header").waitFor();
  return page;
}
async function withBrowser(run:(browser:Browser)=>Promise<void>) {
  const browser = await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
  try {await run(browser);} finally {await browser.close();}
}
browserTest("resolved failure keeps retry and edit; only recorded facts explain refusal",async()=>withBrowser(async browser=>{
  const page = await open(browser,{failure:true});
  await page.getByRole("radio",{name:/Retry on Antigravity/}).waitFor();
  expect(await page.getByText("already been reviewed or superseded",{exact:false}).count()).toBe(0);
  await page.getByRole("textbox",{name:"Note for the next attempt"}).fill("Try again");
  expect(await page.getByText("This service cannot pass feedback",{exact:false}).count()).toBe(1);
  await page.getByRole("radio",{name:/with a note/}).click();
  await page.getByRole("button",{name:/^Retry on Codex/}).click();
  await page.waitForFunction(()=>(window as any).CALLS.some((call:any)=>call.op==="task.review"));
  expect(await page.evaluate(()=>(window as any).CALLS.find((call:any)=>call.op==="task.review").params)).toMatchObject({verdict:"send_back",note:"Try again"});
  await page.close();
  for (const task of [{review:{accepted:true}},{work:{rootId:"root"}},{state:"running"}]) {
    const page = await open(browser,{failure:true,task});
    await page.getByRole("radio",{name:"Edit the brief, then retry"}).click();
    await page.getByRole("button",{name:"Edit the brief, then retry",exact:true}).click();
    await page.waitForURL("**/#/tasks/new");
    await page.close();
  }
}));
browserTest("accepted banner reflects other attention items",async()=>withBrowser(async browser=>{
  for (const [attention,copy] of [[[],"Nothing else needs you."],[[{taskId:"t-0412"},{taskId:"other"},{taskId:"other"}],"1 more needs you · Open Needs you"],[[{taskId:"one"},{taskId:"two"}],"2 more need you · Open Needs you"]] as const) {
    const page = await open(browser,{attention});
    await page.getByRole("button",{name:"Accept result",exact:true}).click();
    await page.locator(".pc-result-accepted").waitFor();
    expect(await page.locator(".pc-result-accepted").innerText()).toContain(copy);
    expect(await page.getByRole("link",{name:"Open Needs you",exact:true}).count()).toBe(attention.length ? 1 : 0);
    if (attention.length) for (const colorScheme of ["light","dark"] as const) {
      await page.emulateMedia({colorScheme});
      const contrast = await page.getByRole("link",{name:"Open Needs you",exact:true}).evaluate(node=>{
        const luminance = (color:string) => {
          const [r,g,b] = color.match(/\d+/g)!.slice(0,3).map(n=>{const value=Number(n)/255;return value<=0.04045 ? value/12.92 : ((value+0.055)/1.055)**2.4;});
          return r!*0.2126+g!*0.7152+b!*0.0722;
        };
        const fg=luminance(getComputedStyle(node).color),bg=luminance(getComputedStyle(node.closest(".pc-result-accepted")!).backgroundColor);
        return (Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05);
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    await page.close();
  }
}));
browserTest("Open file requires a current local direct session; selection clears a read error",async()=>withBrowser(async browser=>{
  for (const settings of [{task:{backend:"orca"}},{task:{machine:"remote"}},{session:{machine:"remote"}},{session:{attempt:null}},{session:{attempt:2}},{session:{host:"orca"}}]) {
    const page = await open(browser,settings);
    await page.waitForFunction(()=>(window as any).CALLS.some((call:any)=>call.op==="task.session"));
    expect(await page.getByRole("button",{name:"Open file",exact:true}).count()).toBe(0);
    await page.close();
  }
  const page = await open(browser,{});
  await page.getByRole("button",{name:"Open file",exact:true}).click();
  await page.getByText("File no longer exists",{exact:true}).waitFor();
  expect(await page.evaluate(()=>(window as any).CALLS.find((call:any)=>call.op==="session.file.read").params)).toMatchObject({attempt:1,reference:"a.ts"});
  await page.getByText("b.ts",{exact:true}).click();
  expect(await page.getByText("File no longer exists",{exact:true}).count()).toBe(0);
}));

browserTest("failure shows its resolution, singular attempt and edit default without ready executors",async()=>withBrowser(async browser=>{
  const page = await open(browser,{failure:true,retryOptions:[],executors:[]});
  await page.getByText("worktree removed",{exact:true}).waitFor();
  expect(await page.locator(".pc-result-meta").innerText()).toContain("1 attempt on");
  expect(await page.getByRole("radio",{name:"Edit the brief, then retry"}).getAttribute("aria-checked")).toBe("true");
  await page.getByRole("button",{name:"Edit the brief, then retry",exact:true}).click();
  await page.waitForURL("**/#/tasks/new");
}));
