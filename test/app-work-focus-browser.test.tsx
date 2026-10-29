import {afterAll,beforeAll,expect,test} from "bun:test";
import {chromium,type Browser} from "playwright-core";

const browserPath=process.env.PACER_TEST_BROWSER;
const browserTest=test.skipIf(!browserPath);
let browser:Browser;
let server:ReturnType<typeof Bun.serve>;

beforeAll(async()=>{
 if(!browserPath)return;
 const built=await Bun.build({entrypoints:["test/fixtures/ui/work-focus-browser.tsx"],target:"browser"});
 if(!built.success)throw new AggregateError(built.logs);
 const script=await built.outputs[0]!.text();
 const styles=(await Promise.all(["app/src/ds/tokens.css","app/src/ds/components.css","app/src/styles.css"].map(path=>Bun.file(path).text()))).join("\n");
 server=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response(`<meta charset="utf-8"><style>${styles}</style><div id="root"></div><script type="module">${script}</script>`,{headers:{"Content-Type":"text/html"}})});
 browser=await chromium.launch({executablePath:browserPath,headless:true});
});
afterAll(async()=>{await browser?.close();server?.stop(true)});

browserTest("keyboard review keeps focus in Work details when Accept disappears",async()=>{
 const page=await browser.newPage();
 try{
  await page.goto(`${server.url}`);
  await page.getByRole("button",{name:"Details",exact:true}).click();
  const accept=page.getByRole("button",{name:"Accept",exact:true});
  await accept.focus();
  await page.keyboard.press("Enter");
  await accept.waitFor({state:"detached"});
  await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==="Hide details");
  expect(await page.getByRole("button",{name:"Hide details"}).evaluate(node=>document.activeElement===node)).toBe(true);
 }finally{await page.close()}
});

 browserTest("Work rounds account movement and average usage percentages", async () => {
  const page = await browser.newPage();
  try {
   await page.goto(`${server.url}`);
   await page.getByText('17% observed account movement', { exact: false }).waitFor();
   expect(await page.locator('.pc-work-analytics tbody').innerText()).toContain('3%');
   expect(await page.locator('#root').innerText()).not.toMatch(/\d+\.\d+%/);
  } finally { await page.close(); }
 });
