import {expect,test} from 'bun:test';
import {chromium} from 'playwright-core';
import {buildApp} from '../app/build';
const login=process.env.PACER_FIDELITY_TEST_URL;
test.skipIf(!login || !process.env.PACER_TEST_BROWSER)('seeded Dispatch fidelity at desktop and phone widths',async()=>{
 const files=new Map((await buildApp()).map(f=>[f.path,f]));
 const browser=await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.route('**/app/**',route=>{const f=files.get(new URL(route.request().url()).pathname.slice(5));return f&&f.path!=='index.html'?route.fulfill({contentType:f.type,body:f.text}):route.continue()});
  await page.goto(login!);await page.locator('.pc-dispatch-chain__sep svg').first().waitFor();
  for(const colorScheme of ['dark','light'] as const){
   await page.emulateMedia({colorScheme});
   const values=await page.evaluate(()=>{
    const css=(s:string)=>getComputedStyle(document.querySelector(s)!);
    return {repo:css('.pc-chip--repo').lineHeight,key:css('.pc-dispatch__controls .pc-kbd').paddingInline,
     track:css('.pc-dispatch-split .pc-meter').backgroundColor,overflow:css('.pc-dispatch-split .pc-meter').overflow,
     tick:document.querySelector('.pc-dispatch-split .pc-meter__pace')!.getBoundingClientRect().height,
     chevron:css('.pc-dispatch-chain__sep svg').width,queue:css('.pc-dispatch-chip__tile').fontWeight,
     series:css('.pc-dispatch-share__segment--1').backgroundColor,padding:css('.pc-attn-card').padding,
     count:css('.pc-count--bad').color,tokens:css('.pc-dispatch-decision__tokens').fontSize};
   });
   expect(values).toEqual({repo:'12px',key:'5px',track:colorScheme==='dark'?'rgb(63, 63, 70)':'rgb(228, 228, 231)',overflow:'visible',tick:16,chevron:'14px',queue:'700',series:'rgb(79, 122, 148)',padding:'12px',count:colorScheme==='dark'?'rgb(24, 24, 27)':'rgb(255, 255, 255)',tokens:'13px'});
  }
  await page.setViewportSize({width:390,height:844});await page.locator('.pc-narrow-planner').waitFor();
  expect(await page.locator('.pc-dispatch-attention .pc-section__head').evaluate(n=>n.getBoundingClientRect().height)).toBe(22);
  expect(await page.locator('.pc-dispatch-attention').evaluate(n=>getComputedStyle(n).gap)).toBe('8px');
  expect(await page.locator('.pc-dispatch-attention .pc-count').count()).toBe(0);
  expect(await page.locator('.pc-narrow-planner').textContent()).toMatch(/pace \d+% · (Relaxed|Normal|Strict|Emergency) · resets/);
  expect(await page.locator('.pc-narrow-planner').textContent()).toContain('Project order for this repository');
  const row=page.locator('.pc-narrow-running__row').first();
  expect(await row.textContent()).toMatch(/running \d+m/);
  expect(await row.evaluate(n=>getComputedStyle(n).flexWrap)).toBe('nowrap');
  expect(await row.evaluate(n=>n.getBoundingClientRect().height)).toBe(61);
  expect(await row.locator('strong').getAttribute('title')).toContain('without creating another flex row');
 }finally{await browser.close()}
},30000);
