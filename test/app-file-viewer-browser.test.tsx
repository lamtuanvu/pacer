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
  ...[["src/big.ts", 2500], ["README.md"], ["docs/long.md"], ["public/index.html"], ["src/gone.ts", 4], ["dist/engine.wasm"]].map(([path, line]) =>
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
},60_000);
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
  expect(await first.getAttribute("aria-label")).toBe("Back to terminal");
  expect(await first.textContent()).toBe("Terminal");
  const more=viewer.getByRole("button",{name:"More file actions"});
  await more.click();
  await expect(viewer.getByRole("button",{name:"Copy path"}).count()).resolves.toBe(1);
  // Safari and WKWebView do not focus a clicked button, so focus leaves with no related target; the menu must stay open.
  await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
  await expect(more.getAttribute("aria-expanded")).resolves.toBe("true");
  await more.focus();
  for(const control of [first,more]){const size=await control.boundingBox();expect(size!.height).toBeGreaterThanOrEqual(36);expect(size!.width).toBeGreaterThanOrEqual(36);}
  await page.keyboard.press("Escape");
  await expect(more.getAttribute("aria-expanded")).resolves.toBe("false");
  expect(await viewer.isVisible()).toBe(true);
 }finally{await page.close()}
},30_000);

browserTest("a large file loads in pages; search covers the lines loaded and Escape closes search before the viewer",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,900,"src/big.ts");
  await viewer.getByText("Large file: showing the first 4,000 lines").waitFor();
  await viewer.getByText("big.ts is ",{exact:false}).getByText("Search covers the lines shown.",{exact:false}).waitFor();
  await page.keyboard.press("Control+f");
  const input=viewer.getByRole("textbox",{name:"Search file"});
  await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="Search file");
  await input.fill("needle");
  // Line 4999 is not loaded yet, so it is not counted.
  await viewer.getByText("1 of 2",{exact:true}).waitFor();
  await expect(viewer.locator(".pc-file-viewer__match--current").count()).resolves.toBe(1);
  await input.press("Enter");
  await viewer.getByText("2 of 2",{exact:true}).waitFor();
  await input.press("Shift+Enter");
  await viewer.getByText("1 of 2",{exact:true}).waitFor();
  await viewer.getByRole("button",{name:"Show next 1,000 lines"}).click();
  await viewer.getByText("Large file: showing the first 5,000 lines").waitFor();
  await viewer.getByText("1 of 3",{exact:true}).waitFor();
  await expect(viewer.getByRole("button",{name:/Show next/}).count()).resolves.toBe(0);
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
  await viewer.getByText("This file isn’t in the workspace").waitFor();
  await expect(viewer.getByRole("button",{name:"Retry"}).count()).resolves.toBe(1);
  await expect(viewer.getByRole("button",{name:"Back to terminal"}).count()).resolves.toBe(1);
 }finally{await page.close()}
},30_000);

const fixture=(page:Page,code:string)=>page.evaluate(`globalThis.fileViewerTest.${code}`);

browserTest("Retry keeps focus in the viewer; Escape then returns to the terminal",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,900,"src/gone.ts");
  await viewer.getByText("This file isn’t in the workspace").waitFor();
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
  await expect(viewer.getByRole("tab",{name:/^(Source|Preview)$/}).count()).resolves.toBe(0);
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

browserTest("a short sheet scrolls the HTML preview panel inside the viewer",async()=>{
 const page=await browser.newPage({viewport:{width:375,height:640}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,375,"public/index.html");
  await viewer.getByRole("tab",{name:"Preview"}).click();
  await viewer.getByRole("note",{name:"Preview is isolated from pacer"}).waitFor();
  const panel=await viewer.locator(".pc-file-viewer__panel").boundingBox();
  const frame=await viewer.boundingBox();
  expect(panel!.y+panel!.height).toBeLessThanOrEqual(frame!.y+frame!.height+1);
  expect(await viewer.locator(".pc-file-viewer__panel").evaluate(element=>getComputedStyle(element).overflowY)).toBe("auto");
  expect(await viewer.locator(".pc-file-viewer__foot").count()).toBe(0);
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
  // Markdown scrolls in its own region, which is the keyboard stop; the panel is a stop only for HTML.
  await viewer.getByRole("tab",{name:"Preview"}).click();
  await expect(viewer.getByRole("tabpanel").getAttribute("tabindex")).resolves.toBeNull();
  await expect(viewer.getByRole("region",{name:"Preview of README.md"}).getAttribute("tabindex")).resolves.toBe("0");
  await viewer.getByRole("button",{name:"Back to terminal"}).click();
  const html=await open(page,375,"public/index.html");
  await html.getByRole("tab",{name:"Preview"}).click();
  await expect(html.getByRole("tabpanel").getAttribute("tabindex")).resolves.toBe("0");
 }finally{await page.close()}
},30_000);

browserTest("the focused Markdown preview scrolls with the keyboard",async()=>{
 const page=await browser.newPage({viewport:{width:375,height:812}});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,375,"docs/long.md");
  await viewer.getByRole("tab",{name:"Preview"}).click();
  const region=viewer.getByRole("region",{name:"Preview of docs/long.md"});
  await region.getByText("Paragraph 1.",{exact:true}).waitFor();
  await viewer.getByRole("tab",{name:"Preview"}).focus();
  await page.keyboard.press("Tab");
  await expect(region.evaluate(element=>element===document.activeElement&&element.matches(":focus-visible"))).resolves.toBe(true);
  await page.keyboard.press("PageDown");
  await page.waitForFunction(()=>(document.querySelector(".pc-file-viewer__markdown")?.scrollTop??0)>0);
 }finally{await page.close()}
},30_000);

// Values from the design canvas (FileViewer.dc.html, ViewerDesktop and ViewerStatesLight), measured as computed styles.
const measure=(viewer:import("playwright-core").Locator,selector:string)=>viewer.locator(selector).first().evaluate(element=>{
 const style=getComputedStyle(element),box=element.getBoundingClientRect();
 return {width:box.width,height:box.height,padding:`${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
  border:`${style.borderTopWidth} ${style.borderRightWidth} ${style.borderBottomWidth} ${style.borderLeftWidth}`,radius:style.borderTopLeftRadius,
  background:style.backgroundColor,color:style.color,size:style.fontSize,line:style.lineHeight,gap:style.gap};
});

browserTest("the viewer matches the design board: flush container, header band, actions, chips, code and footer",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900},colorScheme:"light"});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,1200,"src/big.ts");
  await viewer.getByText("Large file: showing the first 4,000 lines").waitFor();
  // Flush in the side panel: only a 1px left border, no radius, no padding.
  expect(await measure(viewer,"xpath=.")).toMatchObject({border:"0px 0px 0px 1px",radius:"0px",padding:"0px 0px 0px 0px",width:560});
  // The header is its own band.
  expect(await measure(viewer,".pc-file-viewer__head")).toMatchObject({padding:"10px 14px 10px 14px",border:"0px 0px 1px 0px",background:"rgb(250, 250, 250)",gap:"6px"});
  // Search, Copy path and Back to terminal; Open in editor appears only where a host hands off to an editor.
  const names=await viewer.locator(".pc-file-viewer__head button").evaluateAll(buttons=>buttons.map(button=>button.getAttribute("aria-label")));
  expect(names).toEqual(["Search","Copy path","Back to terminal"]);
  for(const label of ["Search","Copy path"])expect(await measure(viewer,`button[aria-label="${label}"]`)).toMatchObject({width:28,height:28,radius:"6px"});
  expect(await measure(viewer,".pc-file-viewer__back")).toMatchObject({height:28,padding:"0px 6px 0px 8px",radius:"6px"});
  expect(await measure(viewer,".pc-file-viewer__back svg")).toMatchObject({width:14,height:14});
  expect(await measure(viewer,".pc-file-viewer__back .pc-kbd")).toMatchObject({height:18,padding:"0px 5px 0px 5px",radius:"4px",size:"11px"});
  expect(await measure(viewer,".pc-file-viewer__glyph")).toMatchObject({width:26,height:26,radius:"6px"});
  expect(await measure(viewer,".pc-file-viewer__title strong")).toMatchObject({size:"14px"});
  // Path row: worktree in muted ink, a plain 20px Line chip and a Session running chip with a 6px good dot.
  expect(await viewer.locator(".pc-file-viewer__path").innerText()).toBe("validate/pwa-drop / src/big.ts");
  expect(await measure(viewer,".pc-file-viewer__workspace")).toMatchObject({color:"rgb(113, 113, 122)"});
  const chips=viewer.locator(".pc-file-viewer__chip");
  expect(await chips.allInnerTexts()).toEqual(["Line 2500","Session running"]);
  expect(await measure(viewer,".pc-file-viewer__chip")).toMatchObject({height:20,radius:"5px",size:"12px",background:"rgb(244, 244, 245)",color:"rgb(82, 82, 91)"});
  expect(await measure(viewer,".pc-file-viewer__dot")).toMatchObject({width:6,height:6,background:"rgb(21, 128, 61)"});
  // Code: 12.5px / 20px mono, 44px right-aligned gutter with 14px padding, linked line tinted with a bold number.
  expect(await measure(viewer,".pc-file-viewer__line")).toMatchObject({size:"12.5px",line:"20px",height:20});
  expect(await measure(viewer,".pc-file-viewer__number")).toMatchObject({width:44,padding:"0px 14px 0px 0px",color:"rgb(113, 113, 122)"});
  expect(await measure(viewer,".pc-file-viewer__line--selected")).toMatchObject({background:"rgb(219, 234, 254)"});
  const selected=await viewer.locator(".pc-file-viewer__line--selected .pc-file-viewer__number").evaluate(element=>({weight:getComputedStyle(element).fontWeight,align:getComputedStyle(element).textAlign}));
  expect(Number(selected.weight)).toBeGreaterThanOrEqual(600);expect(selected.align).toBe("right");
  // Footer: 26px, card background, top border, language · meta · spacer · right-hand info.
  expect(await measure(viewer,".pc-file-viewer__foot")).toMatchObject({height:26,padding:"0px 14px 0px 14px",border:"1px 0px 0px 0px",background:"rgb(250, 250, 250)"});
  expect(await viewer.locator(".pc-file-viewer__foot span:not(.pc-file-viewer__spacer)").allInnerTexts()).toEqual(["TypeScript","UTF-8 · LF · 5,000 lines · 47.8 KB","Ln 2500 · Opened from Codex terminal"]);
  // The linked line sits in the upper third of the view.
  const third=await viewer.locator(".pc-file-viewer__source").evaluate(element=>{
   const target=element.querySelector(".pc-file-viewer__line--selected")!.getBoundingClientRect(),frame=element.getBoundingClientRect();
   return (target.top-frame.top)/frame.height;
  });
  expect(third).toBeGreaterThan(0.2);expect(third).toBeLessThan(0.45);
  // The side-panel tab carries the file name.
  expect(await viewer.locator(".pc-file-viewer__tabs [role=tab]").innerText()).toBe("big.ts");
 }finally{await page.close()}
},30_000);

browserTest("the large-file banner, search highlight and dark theme follow the board",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900},colorScheme:"dark"});page.setDefaultTimeout(5000);
 try{
  const viewer=await open(page,1200,"src/big.ts");
  const banner=viewer.getByRole("note",{name:"Large file"});
  await banner.waitFor();
  expect(await measure(viewer,".pc-file-viewer__banner")).toMatchObject({padding:"10px 14px 10px 14px",border:"0px 0px 1px 0px",background:"rgb(28, 20, 8)"});
  await expect(banner.getByRole("button").allInnerTexts()).resolves.toEqual(["Show next 1,000 lines"]);
  expect(await measure(viewer,".pc-file-viewer__head")).toMatchObject({background:"rgb(24, 24, 27)"});
  expect(await measure(viewer,".pc-file-viewer__line--selected")).toMatchObject({background:"rgb(23, 37, 84)"});
  await page.keyboard.press("Control+f");
  await viewer.getByRole("textbox",{name:"Search file"}).fill("needle");
  await viewer.getByText("1 of 2",{exact:true}).waitFor();
  const marks=await viewer.locator(".pc-file-viewer__match").evaluateAll(elements=>elements.map(element=>({current:element.classList.contains("pc-file-viewer__match--current"),background:getComputedStyle(element).backgroundColor,color:getComputedStyle(element).color})));
  expect(marks[0]).toEqual({current:true,background:"rgb(245, 158, 11)",color:"rgb(24, 24, 27)"});
  expect(await measure(viewer,".pc-file-viewer__search")).toMatchObject({padding:"6px 14px 6px 14px",border:"0px 0px 1px 0px"});
  expect(await measure(viewer,".pc-file-viewer__field")).toMatchObject({height:28,radius:"6px"});
 }finally{await page.close()}
},30_000);

browserTest("loading, missing, unsupported, Markdown Preview and HTML states follow the board",async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(5000);
 try{
  let viewer=await open(page,1200,"README.md");
  await page.evaluate(()=>(globalThis as any).fileViewerTest.defer(true));
  await page.getByRole("button",{name:"Open docs/long.md"}).click();
  await viewer.getByRole("status").filter({hasText:"Reading docs/long.md…"}).waitFor();
  await viewer.locator(".pc-file-viewer__skeleton").waitFor();
  expect(await viewer.locator(".pc-file-viewer__skeleton-row").count()).toBe(14);
  expect(await viewer.locator(".pc-file-viewer__foot").innerText()).toContain("Loading…");
  await page.evaluate(()=>{(globalThis as any).fileViewerTest.resolve("docs/long.md");(globalThis as any).fileViewerTest.defer(false);});
  await viewer.getByText("Paragraph 1.",{exact:true}).waitFor();
  await viewer.getByRole("tab",{name:"Preview"}).click();
  await viewer.getByRole("note",{name:"Rendered safely"}).waitFor();
  expect(await measure(viewer,".pc-file-viewer__markdown")).toMatchObject({padding:"18px 22px 28px 22px"});
  await viewer.getByRole("button",{name:"Back to terminal"}).click();
  viewer=await open(page,1200,"src/gone.ts");
  await viewer.getByText("The agent printed src/gone.ts:4, but there is no file at that path in validate/pwa-drop.",{exact:false}).waitFor();
  await viewer.getByText(/^Checked \d\d:\d\d:\d\d · paths outside the workspace are never opened$/).waitFor();
  expect(await measure(viewer,".pc-file-viewer__state-icon")).toMatchObject({width:40,height:40,radius:"10px"});
  expect(await viewer.locator(".pc-file-viewer__foot").count()).toBe(0);
  await viewer.getByRole("button",{name:"Back to terminal"}).click();
  viewer=await open(page,1200,"dist/engine.wasm");
  await viewer.getByText("pacer can’t show this file").waitFor();
  await viewer.getByText("The viewer shows text files only.",{exact:false}).waitFor();
  await viewer.getByText("Images, PDFs and other binaries open in your own apps").waitFor();
  await viewer.getByRole("button",{name:"Back to terminal"}).click();
  viewer=await open(page,1200,"public/index.html");
  await viewer.getByRole("tab",{name:"Preview"}).click();
  const note=viewer.getByRole("note",{name:"Preview is isolated from pacer"});
  await note.waitFor();
  await viewer.getByText("Sandboxed frame · separate origin · no scripts · no network · no access to pacer").waitFor();
  expect(await measure(viewer,".pc-file-viewer__banner")).toMatchObject({background:"rgb(219, 234, 254)"});
  expect(await measure(viewer,".pc-file-viewer__preview")).toMatchObject({radius:"10px"});
 }finally{await page.close()}
},30_000);
