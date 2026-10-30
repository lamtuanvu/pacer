import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { buildApp } from "../app/build";

const login = process.env.PACER_FIDELITY_TEST_URL;
// CT-11 seeded sandbox only. Serve current source assets without changing embedded release assets.
test.skipIf(!login || !process.env.PACER_TEST_BROWSER)("frame fidelity controls retain board geometry and reachable actions", async () => {
  const files = new Map((await buildApp()).map(file => [file.path, file]));
  const browser = await chromium.launch({ executablePath: process.env.PACER_TEST_BROWSER!, headless: true });
  const style = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
    await context.route("**/app/**", route => {
      const file = files.get(new URL(route.request().url()).pathname.slice(5));
      return file ? route.fulfill({ contentType: file.type, body: file.text }) : route.continue();
    });
    const page = await context.newPage();
    await page.goto(login!); await page.locator(".pc-topbar").waitFor();
    const base = new URL("/app/", login!).href;
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
    const rightKeys = mac ? "Alt+Meta+b" : "Alt+Control+b";
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto(`${base}#/settings/app`);
      expect(await page.locator(".pc-topbar__home svg").evaluate(e => [e.getBoundingClientRect().x,e.getBoundingClientRect().y])).toEqual([84,8.5]);
      for (const button of await page.locator(".pc-layout-toggles button").all()) expect(await button.evaluate(e => [e.getBoundingClientRect().width,e.getBoundingClientRect().height,getComputedStyle(e).borderWidth])).toEqual([28,28,"0px"]);
      expect(await style(page,".pc-command-trigger .pc-kbd","line-height")).toBe("19px");
      for (const selector of [".pc-statusbar__terminal", ".pc-statusbar__help", ".pc-statusbar__usage-button", ".pc-statusbar__pct"]) {
        expect(await style(page,selector,"font-weight")).toBe("400");
        expect(await style(page,selector,"line-height")).toBe("16px");
      }
      expect(await style(page,".pc-statusbar__stale","font-weight")).toBe("700");
      expect(await style(page,".pc-meter--stale .pc-meter__fill","background-color")).toBe(colorScheme === "dark" ? "rgb(63, 63, 70)" : "rgb(228, 228, 231)");
      await page.goto(`${base}#/dispatch`);
      await page.getByRole("button",{name:"Toggle terminal panel (Ctrl+`)",exact:true}).click();
      await page.locator(".pc-tabs--terminal [role=tab]").first().waitFor();
      const geometry = await page.locator(".pc-workspace-terminal__header").evaluate(header => [header,...header.querySelectorAll(".pc-tabs--terminal, [role=tab]")].map(e => [e.getBoundingClientRect().y,e.getBoundingClientRect().height]));
      expect(geometry.every(([y,height]) => y === geometry[0]![0] && height === 30)).toBe(true);
      expect(await page.locator(".pc-terminal-tab-kill").first().evaluate(e => [e.getBoundingClientRect().width,e.getBoundingClientRect().height,getComputedStyle(e).lineHeight,getComputedStyle(e).margin])).toEqual([18,18,"13px","0px 4px 0px -4px"]);
      expect(await style(page,".pc-tabs--terminal [aria-selected=true]","border-bottom-color")).toBe(colorScheme === "dark" ? "rgb(250, 250, 250)" : "rgb(24, 24, 27)");
      await page.getByRole("button",{name:"New terminal in…",exact:true}).click();
      const assertReachable = async () => {
        await page.waitForFunction(() => {const e=document.querySelector(".pc-terminal-menu"); if(!e)return false;const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;},undefined,{timeout:2000}).catch(async error=>{console.error(await page.locator(".pc-terminal-menu").evaluate(e=>({rect:e.getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight],anchor:e.parentElement!.getBoundingClientRect().toJSON()})));throw error;});
      };
      await assertReachable(); await page.keyboard.press("End");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Choose a folder…");
      await page.setViewportSize({width:1440,height:400}); await assertReachable();
      await page.keyboard.press("Home"); await page.keyboard.press("End"); await assertReachable();
      expect(await page.locator('.pc-terminal-menu [role=menuitem]').allTextContents()).not.toContain(expect.stringMatching(/^t-\d/));
      for (const title of await page.locator('.pc-workspace-terminal__header [title]').evaluateAll(es => es.map(e=>e.getAttribute('title')))) expect(title).not.toMatch(/(?:\/Users\/|\/home\/|\/Volumes\/)/);
      await page.keyboard.press("Escape"); await page.setViewportSize({width:1440,height:900});
      await page.getByRole("button",{name:"More terminal actions",exact:true}).click();
      expect(await page.getByRole("menuitem",{name:"Open in external terminal"}).count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.getByRole("button",{name:"Hide panel (Ctrl+`)",exact:true}).click();
      await page.getByRole("button",{name:/Search tasks/}).first().click();
      await page.locator(".pc-command__input").fill(">pa");
      await page.getByRole("group",{name:"Dispatcher",exact:true}).waitFor();
      expect(await page.getByRole("group",{name:"Dispatcher",exact:true}).locator(".pc-command__label").allTextContents()).toEqual(["Pause dispatch","Switch saved setup…","Budget & pacing"]);
      expect(await style(page,".pc-command__search","box-shadow")).toBe("none");
      expect(await style(page,".pc-command__input","outline-style")).toBe("solid");
      expect(await style(page,".pc-command__scope[aria-selected=true] .pc-command__count","opacity")).toBe("0.75");
      await page.locator(".pc-command__input").fill("");
      await page.getByRole("group",{name:"View",exact:true}).waitFor();
      expect(await page.getByRole("group",{name:"View",exact:true}).locator(".pc-command__label").allTextContents()).toEqual(["Toggle left panel","Toggle terminal panel","Toggle right panel"]);
      const right = page.locator('.pc-command__option').filter({hasText:"Toggle right panel"});
      expect(await right.locator('.pc-kbd').allTextContents()).toEqual(mac ? ["⌥","⌘","B"] : ["Alt","Ctrl","B"]);
      await page.keyboard.press("Escape");
      const before = await page.getByRole("button",{name:"Toggle right panel",exact:true}).getAttribute("aria-pressed");
      await page.keyboard.press(rightKeys);
      expect(await page.getByRole("button",{name:"Toggle right panel",exact:true}).getAttribute("aria-pressed")).not.toBe(before);
      await page.keyboard.press(rightKeys);
      await page.getByRole("button",{name:"Open assistant",exact:true}).click();
      expect(await style(page,".pc-aurora-launcher","bottom")).toBe("540px");
      expect(await style(page,".pc-aurora-launcher .pc-kbd","border-width")).toBe("0px");
      expect(await style(page,".pc-assistant-setup__intro>div","gap")).toBe("2px");
      expect(await style(page,".pc-aurora__gradient","animation-duration")).toBe("16s");
      expect(await style(page,".pc-aurora__blobs","animation-duration")).toBe("7s");
      expect(await page.locator(".pc-aurora__blobs span").evaluateAll(es => es.map(e=>getComputedStyle(e).animationDuration))).toEqual(["9s","11s","13s"]);
      await page.emulateMedia({reducedMotion:"reduce"});
      expect(await style(page,".pc-aurora__gradient","animation-name")).toBe("none");
      await page.emulateMedia({reducedMotion:"no-preference"});
      await page.getByRole("button",{name:"Close assistant",exact:true}).click();
    }
    await page.setViewportSize({width:375,height:812});
    await page.goto(`${base}#/dispatch`);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  } finally { await browser.close(); }
}, 60000);
