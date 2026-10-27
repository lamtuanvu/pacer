import {afterAll,beforeAll,expect,test} from "bun:test";
import {chromium,type Browser,type Page} from "playwright-core";

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser;
let server:ReturnType<typeof Bun.serve>;

// The stub terminal exposes link activation and the xterm input that focus returns to.
const stubTerminal=`import { h } from "preact";
export const LazyTerminal = props => h("div", { "data-stub-terminal": "" },
  h("textarea", { className: "xterm-helper-textarea", "aria-label": "Terminal input" }),
  ...[["src/big.ts", 2500], ["README.md"], ["public/index.html"], ["src/gone.ts", 4]].map(([path, line]) =>
    h("button", { type: "button", onClick: () => props.onOpenFile(path, line) }, "Open " + path)));`;

// Viewer import wrapper: with ?failViewer the lazy module resolves without a component until the test enables it.
const viewerWrapper=`import { FileViewer as Real } from ${JSON.stringify(`${process.cwd()}/app/src/screens/session/FileViewer.tsx`)};
export let FileViewer = location.search.includes("failViewer") ? undefined : Real;
globalThis.enableViewer = () => { FileViewer = Real; };`;

beforeAll(async()=>{
 if(!browserPath)return;
 const built=await Bun.build({entrypoints:["test/fixtures/ui/file-viewer-browser.tsx"],target:"browser",plugins:[{name:"stub-pty-view",setup(builder){
  builder.onResolve({filter:/term\/LazyTerminal$/},()=>({path:"stub",namespace:"terminal-stub"}));
  builder.onLoad({filter:/.*/,namespace:"terminal-stub"},()=>({contents:stubTerminal,loader:"js",resolveDir:process.cwd()}));
  builder.onResolve({filter:/^\.\/FileViewer$/},args=>args.importer.endsWith("LinkedTerminal.tsx")?{path:"wrapper",namespace:"viewer-wrapper"}:undefined);
  builder.onLoad({filter:/.*/,namespace:"viewer-wrapper"},()=>({contents:viewerWrapper,loader:"js",resolveDir:process.cwd()}));
 }}]});
 if(!built.success)throw new AggregateError(built.logs);
 const script=await built.outputs[0]!.text();
 const styles=(await Promise.all(["app/src/ds/tokens.css","app/src/ds/components.css","app/src/styles.css","app/src/screens/session/file-viewer.css"].map(path=>Bun.file(path).text()))).join("\n");
 server=Bun.serve({port:0,hostname:"127.0.0.1",fetch:request=>new URL(request.url).pathname==="/fixture.js"?new Response(script,{headers:{"Content-Type":"text/javascript"}}):new Response(`<meta charset="utf-8"><style>${styles}</style><div id="root"></div><script type="module" src="/fixture.js"></script>`,{headers:{"Content-Type":"text/html"}})});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
});
afterAll(async()=>{await browser?.close();server?.stop(true)});

async function open(page:Page,width:number,path:string,query=""){
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 await page.goto(`${server.url}${query}`);
 await page.waitForFunction(()=>(globalThis as any).fileViewerTest).catch(()=>{throw new Error(errors.join("\n")||"fixture did not start")});
 await page.evaluate(value=>(globalThis as any).fileViewerTest.setWidth(value),width);
 await page.getByRole("button",{name:`Open ${path}`}).click();
 return page.getByRole("region",{name:/^File viewer:/});
}

browserTest("a wide container keeps the terminal beside a 560 px pane; Back to terminal closes it",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,1200,"README.md");
  await viewer.getByText("Body text.").waitFor();
  expect(await viewer.getAttribute("data-layout")).toBe("pane");
  expect(await page.locator("[data-stub-terminal]").isVisible()).toBe(true);
  const box=await page.locator(".pc-linked-terminal__viewer").boundingBox();
  expect(Math.round(box!.width)).toBe(560);
  await viewer.getByRole("button",{name:"Back to terminal"}).click();
  await viewer.waitFor({state:"detached"});
  await page.waitForFunction(()=>document.activeElement?.classList.contains("xterm-helper-textarea"));
 }finally{await page.close()}
},30_000);

browserTest("below 1100 px the viewer replaces the terminal; below 768 px it is a sheet led by Back to terminal",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,900,"README.md");
  await viewer.getByText("Body text.").waitFor();
  expect(await viewer.getAttribute("data-layout")).toBe("replace");
  expect(await page.locator("[data-stub-terminal]").isVisible()).toBe(false);
  await page.setViewportSize({width:375,height:812});
  await page.evaluate(()=>(globalThis as any).fileViewerTest.setWidth(375));
  await page.waitForFunction(()=>document.querySelector("[data-layout]")?.getAttribute("data-layout")==="sheet");
  const first=viewer.getByRole("button").first();
  expect(await first.textContent()).toContain("Back to terminal");
  const more=viewer.getByRole("button",{name:"More file actions"});
  await more.click();
  await expect(viewer.getByRole("button",{name:"Copy path"}).count()).resolves.toBe(1);
  // Safari and WKWebView do not focus a clicked button, so focus leaves with no related target; the menu must stay open.
  await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
  await expect(more.getAttribute("aria-expanded")).resolves.toBe("true");
  await more.focus();
  for(const control of [first,more]){const size=await control.boundingBox();expect(size!.height).toBeGreaterThanOrEqual(44);expect(size!.width).toBeGreaterThanOrEqual(44);}
  await page.keyboard.press("Escape");
  await expect(more.getAttribute("aria-expanded")).resolves.toBe("false");
  expect(await viewer.isVisible()).toBe(true);
 }finally{await page.close()}
},30_000);

browserTest("search counts the whole file, steps across pages and Escape closes search before the viewer",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,900,"src/big.ts");
  await viewer.getByText("Showing lines 2001–4000 of 5000; search covers the whole file").waitFor();
  await page.keyboard.press("Control+f");
  const input=viewer.getByRole("textbox",{name:"Search file"});
  await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="Search file");
  await input.fill("needle");
  await viewer.getByText("1 of 3",{exact:true}).waitFor();
  await viewer.getByText(/Showing lines 1–2000/).waitFor();
  await expect(viewer.locator(".pc-file-viewer__match--current").count()).resolves.toBe(1);
  await input.press("Enter");
  await viewer.getByText("2 of 3",{exact:true}).waitFor();
  await viewer.getByText(/Showing lines 2001–4000/).waitFor();
  await input.press("Enter");
  await viewer.getByText("3 of 3",{exact:true}).waitFor();
  await viewer.getByText(/Showing lines 4001–5000/).waitFor();
  await input.press("Shift+Enter");
  await viewer.getByText("2 of 3",{exact:true}).waitFor();
  await viewer.getByRole("button",{name:"Match case"}).click();
  await expect(viewer.getByRole("button",{name:"Match case"}).getAttribute("aria-pressed")).resolves.toBe("true");
  await input.fill("NEEDLE");
  await viewer.getByText("No matches",{exact:true}).waitFor();
  await input.press("Escape");
  await input.waitFor({state:"detached"});
  expect(await viewer.isVisible()).toBe(true);
  await page.keyboard.press("Escape");
  await viewer.waitFor({state:"detached"});
  await page.waitForFunction(()=>document.activeElement?.classList.contains("xterm-helper-textarea"));
 }finally{await page.close()}
},30_000);

browserTest("Markdown and HTML open on Source; HTML preview shows the isolation banner; errors keep Back to terminal",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  let viewer=await open(page,900,"public/index.html");
  const source=viewer.getByRole("tab",{name:"Source"});
  await source.waitFor();
  expect(await source.getAttribute("aria-selected")).toBe("true");
  expect(await viewer.locator("iframe").count()).toBe(0);
  await source.focus();
  await page.keyboard.press("ArrowRight");
  await viewer.getByRole("note",{name:"Preview is isolated from pacer"}).waitFor();
  await viewer.getByText("1 script and 0 external requests were blocked.",{exact:false}).waitFor();
  expect(await viewer.locator("iframe[sandbox='']").count()).toBe(1);
  await viewer.getByRole("button",{name:"Back to terminal"}).click();
  viewer=await open(page,900,"src/gone.ts");
  await viewer.getByText("This file isn't in the workspace").waitFor();
  await expect(viewer.getByRole("button",{name:"Retry"}).count()).resolves.toBe(1);
  await expect(viewer.getByRole("button",{name:"Back to terminal"}).count()).resolves.toBe(1);
 }finally{await page.close()}
},30_000);

const fixture=(page:Page,code:string)=>page.evaluate(`globalThis.fileViewerTest.${code}`);

browserTest("Retry keeps focus in the viewer; Escape then returns to the terminal",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,900,"src/gone.ts");
  await viewer.getByText("This file isn't in the workspace").waitFor();
  await fixture(page,'addFile("src/gone.ts")');
  await viewer.getByRole("button",{name:"Retry"}).click();
  await viewer.getByText("restored").waitFor();
  expect(await page.evaluate(()=>document.activeElement?.classList.contains("pc-file-viewer__title"))).toBe(true);
  await page.keyboard.press("Escape");
  await viewer.waitFor({state:"detached"});
  await page.waitForFunction(()=>document.activeElement?.classList.contains("xterm-helper-textarea"));
 }finally{await page.close()}
},30_000);

browserTest("the latest link wins when reads finish out of order",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,1200,"README.md");
  await fixture(page,"defer(true)");
  await page.getByRole("button",{name:"Open public/index.html"}).click();
  await page.getByRole("button",{name:"Open src/big.ts"}).click();
  await page.waitForFunction(()=>(globalThis as any).fileViewerTest.pending().length===2);
  await fixture(page,'resolve("src/big.ts")');
  await viewer.getByText("line 2500 needle").waitFor();
  await fixture(page,'resolve("public/index.html")');
  await page.waitForTimeout(200);
  expect(await viewer.getAttribute("aria-label")).toBe("File viewer: src/big.ts");
  await expect(viewer.getByRole("tab").count()).resolves.toBe(0);
 }finally{await page.close()}
},30_000);

browserTest("a new attempt clears the viewer; the terminal node survives open and close",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,900,"README.md");
  // Tag the terminal node; a remount would lose the tag.
  await page.evaluate(()=>{(document.querySelector("[data-stub-terminal]") as any).__mark="same";});
  await viewer.getByRole("button",{name:"Back to terminal"}).click();
  await viewer.waitFor({state:"detached"});
  await page.getByRole("button",{name:"Open README.md"}).click();
  await viewer.getByText("Body text.").waitFor();
  await viewer.getByRole("button",{name:"Back to terminal"}).click();
  await viewer.waitFor({state:"detached"});
  expect(await page.evaluate(()=>(document.querySelector("[data-stub-terminal]") as any).__mark)).toBe("same");
  await page.getByRole("button",{name:"Open README.md"}).click();
  await viewer.getByText("Body text.").waitFor();
  await fixture(page,"setAttempt(2)");
  await viewer.waitFor({state:"detached"});
  expect(await page.locator("[data-stub-terminal]").isVisible()).toBe(true);
  expect(await page.evaluate(()=>(document.querySelector("[data-stub-terminal]") as any).__mark)).toBe("same");
 }finally{await page.close()}
},30_000);

browserTest("a failed viewer load offers Try again, which recovers",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  await open(page,900,"README.md","?failViewer");
  await page.getByRole("alert").filter({hasText:"Could not load the file viewer."}).waitFor();
  await page.evaluate(()=>(globalThis as any).enableViewer());
  await page.getByRole("button",{name:"Try again"}).click();
  await page.getByRole("region",{name:/^File viewer:/}).getByText("Body text.").waitFor();
  await expect(page.getByRole("alert").count()).resolves.toBe(0);
 }finally{await page.close()}
},30_000);

browserTest("a short sheet scrolls the HTML preview panel instead of drawing it over the footer",async()=>{
 const page=await browser.newPage({viewport:{width:375,height:640}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,375,"public/index.html");
  await viewer.getByRole("tab",{name:"Preview"}).click();
  await viewer.getByRole("note",{name:"Preview is isolated from pacer"}).waitFor();
  const panel=await viewer.locator(".pc-file-viewer__panel").boundingBox();
  const foot=await viewer.locator(".pc-file-viewer__foot").boundingBox();
  expect(panel!.y+panel!.height).toBeLessThanOrEqual(foot!.y+1);
  expect(await viewer.locator(".pc-file-viewer__panel").evaluate(element=>getComputedStyle(element).overflowY)).toBe("auto");
 }finally{await page.close()}
},30_000);

browserTest("inside the scrolling panel the source focus ring stays visible and the preview panel takes keyboard focus",async()=>{
 const page=await browser.newPage({viewport:{width:375,height:640}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,375,"README.md");
  await viewer.getByRole("tab",{name:"Source"}).focus();
  await page.keyboard.press("Tab");
  const ring=await viewer.locator(".pc-file-viewer__source").evaluate(element=>{
   const panel=element.closest(".pc-file-viewer__panel")!.getBoundingClientRect(),box=element.getBoundingClientRect(),style=getComputedStyle(element);
   const grow=parseFloat(style.outlineOffset)+parseFloat(style.outlineWidth);
   return {visible:element.matches(":focus-visible"),inside:box.left-grow>=panel.left-0.5&&box.right+grow<=panel.right+0.5&&box.bottom+grow<=panel.bottom+0.5};
  });
  expect(ring).toEqual({visible:true,inside:true});
  await viewer.getByRole("tab",{name:"Preview"}).click();
  await expect(viewer.getByRole("tabpanel").getAttribute("tabindex")).resolves.toBe("0");
 }finally{await page.close()}
},30_000);
