import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { appRoute } from "../src/serve/app-routes";
import { fakeCtx } from "./helpers";

const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : chromium.executablePath());
test.skipIf(!existsSync(executable))("real xterm retains monospace geometry and ANSI styling under the production CSP", async () => {
  const build = await Bun.build({entrypoints: [join(import.meta.dir, "fixtures/terminal-style.ts")], target: "browser"});
  if (!build.success) throw new AggregateError(build.logs);
  const js = await build.outputs[0]!.text();
  const response = appRoute(new Request("http://localhost/app/"), fakeCtx());
  const original = await response.text();
  const meta = original.match(/<meta name="pacer-style-nonce"[^>]*>/)![0];
  const html = `<html><head>${meta}<link rel="stylesheet" href="/term.css"></head><body><div id="terminal"></div><script type="module" src="/fixture.js"></script></body></html>`;
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === "/fixture.js") return new Response(js, {headers: {"Content-Type": "text/javascript"}});
    if (path === "/term.css") return new Response(Bun.file(join(import.meta.dir, "../node_modules/@xterm/xterm/css/xterm.css")), {headers: {"Content-Type": "text/css"}});
    return new Response(html, {headers: response.headers});
  }});
  const browser = await chromium.launch({headless: true, executablePath: executable});
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    const style = await page.locator(".xterm-rows").evaluate(element => {
      const computed = getComputedStyle(element);
      const colored = [...element.querySelectorAll("span")].map(span => getComputedStyle(span).color);
      const styles = [...document.querySelectorAll("style")];
      return {font: computed.fontFamily, whiteSpace: computed.whiteSpace, colored, nonceStyles: styles.filter(style => !!style.nonce).length, blocked: styles.filter(style => !style.nonce).map(style => ({css: style.textContent, blocked: style.sheet === null}))};
    });
    expect(style.font).toContain("monospace");
    expect(style.whiteSpace).toBe("pre");
    expect(style.colored).toContain("rgb(204, 0, 0)");
    expect(style.nonceStyles).toBe(2);
    // xterm6's optional scrollbar stylesheet uses window.document rather than
    // documentOverride. It remains blocked; never relax CSP to authorize it.
    expect(style.blocked).toHaveLength(1);
    expect(style.blocked[0]?.css).toStartWith(".xterm .xterm-scrollable-element > .scrollbar > .slider");
    expect(style.blocked[0]?.blocked).toBe(true);
  } finally {await browser.close(); server.stop(true);}
}, 30000);
