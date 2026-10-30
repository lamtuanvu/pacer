import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { generateTokensCss, readTokens } from '../app/tokens-gen';
const browserTest = test.skipIf(!process.env.PACER_TEST_BROWSER);
browserTest('NowCard routes interactive output to raw read-only terminal; headless, errors and acceptance stay distinct', async () => {
  const build = await Bun.build({entrypoints:['test/fixtures/trace-preview-browser.tsx'],target:'browser'});
  expect(build.success).toBe(true);
  const browser = await chromium.launch({executablePath:process.env.PACER_TEST_BROWSER!,headless:true});
  const css = [generateTokensCss(readTokens('app/src/ds')), ...await Promise.all(['app/src/ds/components.css','app/src/styles.css','app/src/screens/session/session.css','app/src/screens/trace/trace.css','node_modules/@xterm/xterm/css/xterm.css'].map(path=>Bun.file(path).text()))].join('\n');
  try {
    for (const settings of [{}, {session:{host:'none'}}, {session:{host:'none'},log:'long-output-'.repeat(5000)}, {session:{host:'orca'}}, {session:{capabilities:{snapshot:false}}}, {error:true}, {compact:true}, {task:{state:'failed',acceptance:{state:'failed',tail:'Failed acceptance check'}}}]) {
      const page = await browser.newPage({viewport:{width:375,height:844}});
      await page.route('http://pacer.test/**', route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
      await page.goto('http://pacer.test');
      await page.evaluate(settings=>{
        (window as any).SETTINGS=settings;
        const sockets:any[]=(window as any).SOCKETS=[];
        (window as any).WebSocket=class {
          readyState=1; binaryType=''; sent:any[]=[]; onopen:any; onmessage:any; onclose:any; onerror:any;
          constructor(public url:string){sockets.push(this);setTimeout(()=>{this.onopen?.();this.frame({type:'snapshot',cols:120,rows:40,outputOffset:0,scrollbackAnsi:'',screenAnsi:'old\r\x1b[2KUpdated Codex screen\r\n\x1b[39;48;2;30;30;30mActual Codex default foreground\x1b[0m',controller:null,viewers:1});},30);}
          frame(value:any){this.onmessage?.({data:JSON.stringify(value)});}
          send(value:any){this.sent.push(value);} close(){}
        };
      },settings);
      await page.addStyleTag({content:css});
      await page.addScriptTag({content:await build.outputs[0]!.text(),type:'module'});
      if (!Object.keys(settings).length) {
        await page.getByText('Watching · read-only',{exact:true}).waitFor();
        await page.getByRole('checkbox',{name:'Screen reader'}).check();
        await page.waitForFunction(()=>document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('Updated Codex screen'));
        expect(await page.locator('.xterm-accessibility-tree').innerText()).not.toContain('old');
        expect(await page.evaluate(()=>(window as any).SOCKETS[0].url)).toBe('ws://pacer.test/raw-session');
        // Codex restores the default foreground (SGR39) over its own dark truecolor panel.
        // Inspect real rendered cells so swapping ANSI black/white cannot satisfy this regression.
        for (const theme of ['light','dark','light']) {
          await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
          await page.waitForTimeout(100);
          const colors=await page.locator('.xterm-rows span').filter({hasText:'Actual Codex default foreground'}).first().evaluate(cell=>{
            const style=getComputedStyle(cell);
            const luminance=(color:string)=>{
              const channels=color.match(/\d+/g)!.slice(0,3).map(Number).map(n=>{const s=n/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4;});
              return channels[0]!*.2126+channels[1]!*.7152+channels[2]!*.0722;
            };
            const fg=luminance(style.color),bg=luminance(style.backgroundColor);
            const frame=document.querySelector('.pc-terminal-frame')!;
            const viewport=document.querySelector('.xterm-viewport')!;
            return {background:style.backgroundColor,contrast:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05),frame:getComputedStyle(frame).backgroundColor,viewport:getComputedStyle(viewport).backgroundColor};
          });
          expect(colors.background).toBe('rgb(30, 30, 30)');
          expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
          expect(colors.frame).toBe(colors.viewport);
        }
        // Measure rendered rows, including ancestor transforms: font-size alone misses scaled glyphs.
        const pane = page.getByRole('region', {name:'Scrollable terminal output',exact:true});
        for (const width of [1440,375]) {
          await page.setViewportSize({width,height:900});
          await page.waitForTimeout(200);
          const geometry = await page.locator('.xterm-rows > div').first().evaluate(row=>{
            const scale=row.getBoundingClientRect().height/(row as HTMLElement).offsetHeight;
            return {glyph:parseFloat(getComputedStyle(row).fontSize)*scale,line:row.getBoundingClientRect().height};
          });
          expect(geometry.glyph).toBeGreaterThanOrEqual(12);
          expect(geometry.line).toBeGreaterThanOrEqual(16);
          expect(await pane.evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);
          if (width===375) {
            expect(await pane.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
            await pane.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('PageDown');
            await page.waitForTimeout(200);
            expect(await pane.evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);
            expect(await pane.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
            await pane.evaluate(node=>{node.scrollTop=0;node.scrollLeft=0;});
          }
          expect(await page.locator('body').evaluate(node=>node.scrollWidth<=innerWidth)).toBe(true);
        }
        await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('do not send');
        await page.setViewportSize({width:1200,height:900});
        await page.waitForTimeout(250);
        expect(await page.evaluate(()=>(window as any).SOCKETS[0].sent.map((s:string)=>JSON.parse(s).type))).toEqual(['hello']);
        await page.evaluate(()=>{(window as any).SOCKETS[0].onclose();});
        await page.waitForFunction(()=>(window as any).SOCKETS.length===2);
        await page.getByText('Watching · read-only',{exact:true}).waitFor();
        expect(await page.locator('.pc-terminal-pane').evaluate(node=>node.getBoundingClientRect().height)).toBe(320);
        expect(await page.locator('body').evaluate(node=>node.scrollWidth<=innerWidth)).toBe(true);
        expect(await page.getByRole('button',{name:'Take control',exact:true}).count()).toBe(0);
        await page.evaluate(()=>{(window as any).SOCKETS[1].frame({type:'resize',cols:100,rows:30});});
        await page.getByText('100×30',{exact:true}).waitFor();
        expect(await page.evaluate(()=>(window as any).SOCKETS[1].sent.map((s:string)=>JSON.parse(s).type))).toEqual(['hello']);
      } else if ('error' in settings) {
        await page.getByText('Could not load the session.',{exact:false}).waitFor();
        await page.getByRole('button',{name:'Try again',exact:true}).click();
        await page.waitForFunction(()=>(window as any).CALLS.length===2);
      }
      else if ('compact' in settings) {await page.getByRole('heading').waitFor();await page.waitForTimeout(100);}
      else if ('task' in settings) await page.getByLabel('Failed check output').waitFor();
      else if (settings.session?.host==='none') {
        const output=page.getByLabel('Task output',{exact:true}); await output.waitFor();
        expect(await output.evaluate(node=>node.getBoundingClientRect().height)).toBeLessThanOrEqual(270);
        expect(await page.locator('body').evaluate(node=>node.scrollWidth<=innerWidth)).toBe(true);
      }
      else await page.getByText(settings.session?.host==='orca'?'This session runs in Orca. Open the workspace to follow it in Orca.':'Terminal preview is unavailable for this session.',{exact:true}).waitFor();
      const calls = await page.evaluate(()=>(window as any).CALLS);
      expect(calls.includes('task.log')).toBe('session' in settings && settings.session?.host==='none');
      if ('compact' in settings || 'task' in settings) expect(calls).toEqual([]);
      await page.close();
    }
  } finally {await browser.close();}
},30000);
