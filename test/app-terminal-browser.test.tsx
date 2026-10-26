import {expect,test} from "bun:test";
import {chromium} from "playwright-core";

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);

browserTest("terminal page creates, selects, renames, splits and closes tabs with keyboard control",async()=>{
  const build=await Bun.build({entrypoints:["test/fixtures/terminal-browser.tsx"],target:"browser",splitting:false,plugins:[{name:"stub-pty-view",setup(builder){
    builder.onResolve({filter:/term\/LazyTerminal$/},()=>({path:"stub",namespace:"terminal-stub"}));
    builder.onLoad({filter:/.*/,namespace:"terminal-stub"},()=>({contents:"export const LazyTerminal = () => null;",loader:"js"}));
  }}]});
  expect(build.success).toBe(true);
  const source=await build.outputs[0]!.text();
  const browser=await chromium.launch({executablePath:browserPath!,headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.setContent('<div id="root"></div>');
    await page.evaluate(async code=>{const url=URL.createObjectURL(new Blob([code],{type:"text/javascript"}));await import(url);URL.revokeObjectURL(url);},source);
    await expect(page.getByRole("button",{name:"New terminal"}).count()).resolves.toBe(1);
    await page.getByRole("button",{name:"New terminal"}).click();
    await page.getByRole("navigation",{name:"Terminals"}).waitFor();
    await expect(page.getByRole("navigation",{name:"Terminals"}).getByRole("button",{name:"Shell",exact:true}).count()).resolves.toBe(1);
    const tabs=page.getByRole("navigation",{name:"Terminals"}).getByRole("button",{name:"Shell",exact:true});
    await page.getByRole("button",{name:"New terminal"}).click();
    await tabs.nth(1).waitFor();
    await expect(tabs.count()).resolves.toBe(2);
    await tabs.nth(1).focus();await page.keyboard.press("ArrowLeft");
    await expect(tabs.nth(0).getAttribute("aria-current")).resolves.toBe("page");
    await page.getByRole("button",{name:"Rename"}).click();
    await page.getByRole("textbox",{name:"Terminal name"}).fill("Build");
    await page.getByRole("button",{name:"Save name"}).click();
    await expect(page.getByRole("navigation",{name:"Terminals"}).getByRole("button",{name:"Build",exact:true}).count()).resolves.toBe(1);
    await page.getByRole("button",{name:"Split right"}).click();
    await expect(page.getByRole("region",{name:/Terminal:/}).count()).resolves.toBe(2);
    await page.getByRole("button",{name:"Close Build"}).click();
    await page.getByRole("heading",{name:/close terminal/i}).waitFor();
    await page.getByRole("button",{name:"Stop and close"}).click();
    await expect(page.getByRole("navigation",{name:"Terminals"}).getByRole("button",{name:"Build",exact:true}).count()).resolves.toBe(0);
  }finally{await browser.close();}
}, 30_000);

browserTest("a definite launch refusal stays visible across polling and a retry can proceed",async()=>{
  const build=await Bun.build({entrypoints:["test/fixtures/terminal-browser.tsx"],target:"browser",splitting:false,plugins:[{name:"stub-pty-view",setup(builder){builder.onResolve({filter:/term\/LazyTerminal$/},()=>({path:"stub",namespace:"terminal-stub"}));builder.onLoad({filter:/.*/,namespace:"terminal-stub"},()=>({contents:"export const LazyTerminal = () => null;",loader:"js"}));}}]});
  expect(build.success).toBe(true);
  const source=await build.outputs[0]!.text();const browser=await chromium.launch({executablePath:browserPath!,headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<div id="root"></div>');
    await page.evaluate(async code=>{const url=URL.createObjectURL(new Blob([code],{type:"text/javascript"}));await import(url);URL.revokeObjectURL(url);},source);
    await page.evaluate(()=>(globalThis as any).terminalTest.setCreateError("not_allowed"));
    await page.getByRole("button",{name:"New terminal"}).click();
    await page.getByText("Launch refused").waitFor();
    await expect(page.getByText("Launch refused").count()).resolves.toBe(1);
    await page.waitForTimeout(2200);
    await expect(page.getByText("Launch refused").count()).resolves.toBe(1);
    await page.evaluate(()=>(globalThis as any).terminalTest.setCreateError(""));
    await page.getByRole("button",{name:"New terminal"}).click();
    await expect(page.getByRole("navigation",{name:"Terminals"}).getByRole("button",{name:"Shell",exact:true}).count()).resolves.toBe(1);
  }finally{await browser.close();}
}, 30_000);

browserTest("terminal output search finds a match and reports missing text by keyboard and buttons",async()=>{
  const build=await Bun.build({entrypoints:["test/fixtures/terminal-search-browser.tsx"],target:"browser",splitting:false,plugins:[{name:"recorded-terminal-session",setup(builder){
    builder.onResolve({filter:/^\.\/client$/},args=>args.importer.endsWith("/app/src/term/term.tsx")?{path:"recorded-session",namespace:"recorded-session"}:undefined);
    builder.onLoad({filter:/.*/,namespace:"recorded-session"},()=>({contents:`export class SessionClient {
      constructor(options){this.options=options;this.state={status:"live",you:false,controller:null,cols:80,rows:24,viewers:1};}
      connect(){this.options.onSnapshot({cols:80,rows:24,scrollbackAnsi:"SEARCH_MATCH_734\\r\\n",screenAnsi:""});this.options.onState(this.state);}
      dispose(){} input(){} resize(){} release(){} take(){return Promise.resolve();}
    }`,loader:"js"}));
  }}]});
  expect(build.success).toBe(true);
  const source=await build.outputs[0]!.text();
  const browser=await chromium.launch({executablePath:browserPath!,headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:700}});
    await page.setContent('<style>.pc-terminal-pane{width:800px;height:400px}</style><div id="root"></div>');
    await page.addStyleTag({path:"node_modules/@xterm/xterm/css/xterm.css"});
    await page.evaluate(async code=>{const url=URL.createObjectURL(new Blob([code],{type:"text/javascript"}));await import(url);URL.revokeObjectURL(url);},source);
    await page.waitForFunction(()=>document.querySelector(".xterm-rows")?.textContent?.includes("SEARCH_MATCH_734"),undefined,{timeout:5000});
    const search=page.getByRole("textbox",{name:"Search terminal output"});
    await search.fill("SEARCH_MATCH_734");
    await search.press("Enter");
    await expect(page.getByText("No match").count()).resolves.toBe(0);
    await page.getByRole("button",{name:"Previous"}).click();
    await expect(page.getByText("No match").count()).resolves.toBe(0);
    await search.fill("NO_MATCH_987653");
    await page.getByRole("button",{name:"Next"}).click();
    await page.getByText("No match").waitFor();
    await search.press("Shift+Enter");
    await expect(page.getByText("No match").count()).resolves.toBe(1);
  }finally{await browser.close();}
},30_000);
