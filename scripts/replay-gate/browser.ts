import { chromium, type BrowserContext, type Page } from "playwright-core";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

/** Real Chromium screenshots, fixed size/font/DPR, same browser and renderer for both payloads. */
export async function browserComparator(output:string) {
  const main = import.meta.resolve("@xterm/xterm").replace(/^file:\/\//, "");
  const root = dirname(dirname(main));
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/xterm.js") return new Response(Bun.file(main),{headers:{"content-type":"text/javascript"}});
    if (path === "/xterm.css") return new Response(Bun.file(join(root,"css/xterm.css")),{headers:{"content-type":"text/css"}});
    if (path !== "/") return new Response("Not found",{status:404});
    return new Response(`<!doctype html><link rel="stylesheet" href="/xterm.css"><style>body{margin:0;background:#000}#terminal{display:inline-block}</style><div id="terminal"></div><script src="/xterm.js"></script><script>
      window.renderReplay=async function(base64){
        if(window.term)window.term.dispose();
        document.getElementById('terminal').replaceChildren();
        const term=window.term=new Terminal({cols:120,rows:40,scrollback:5000,allowProposedApi:true,fontFamily:'monospace',fontSize:12,lineHeight:1,cursorBlink:false,theme:{background:'#000000',foreground:'#ffffff'}});
        term.open(document.getElementById('terminal'));term.focus();
        await document.fonts.ready;
        const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
        await new Promise(resolve=>term.write(bytes,resolve));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      };
    </script>`,{headers:{"content-type":"text/html"}});
  }});
  let browser;
  try { browser = await chromium.launch({headless:true,executablePath:process.env.VT100_SPIKE_CHROMIUM ?? process.env.PACER_TEST_BROWSER,timeout:15000}); }
  catch(error) { await server.stop(true); throw error; }
  let context:BrowserContext;
  let page:Page;
  try {
    context = await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1,reducedMotion:"reduce"});
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await mkdir(output,{recursive:true});
  } catch(error) {
    await browser.close();
    await server.stop(true);
    throw error;
  }
  const screenshot = async (replay:string) => {
    await page.evaluate(async base64 => {
      await (window as unknown as {renderReplay(value:string):Promise<void>}).renderReplay(base64);
    },Buffer.from(replay).toString("base64"));
    return page.locator("#terminal .xterm-screen").screenshot({animations:"disabled"});
  };
  const pixels = async (png:Buffer) => page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64),c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes],{type:"image/png"}));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap,0,0);
    const rgba = context.getImageData(0,0,canvas.width,canvas.height).data;
    const digest = await crypto.subtle.digest("SHA-256",rgba);
    bitmap.close();
    return {width:canvas.width,height:canvas.height,sha256:Array.from(new Uint8Array(digest),n => n.toString(16).padStart(2,"0")).join("")};
  },png.toString("base64"));
  return {
    version:browser.version(),
    async compare(id:string,reference:string,candidate:string) {
      const before = await screenshot(reference), after = await screenshot(candidate);
      const referencePixels = await pixels(before), candidatePixels = await pixels(after);
      const equal = referencePixels.width === candidatePixels.width && referencePixels.height === candidatePixels.height
        && referencePixels.sha256 === candidatePixels.sha256;
      if (!equal) await Promise.all([
        writeFile(join(output,`${id}-xterm.png`),before),writeFile(join(output,`${id}-candidate.png`),after),
      ]);
      return {equal,referencePixels,candidatePixels};
    },
    async close() {await context.close();await browser.close();await server.stop(true);},
  };
}
