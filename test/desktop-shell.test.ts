import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../desktop/ui/shell.js", import.meta.url), "utf8");
function shell(search: string) {
  const elements = new Map<string, any>();
  const timers: (() => void)[] = [];
  let now = 0;
  const document = {
    querySelector(selector: string) {
      if (!elements.has(selector)) elements.set(selector, { hidden: false, value: "", textContent: "", addEventListener() {} });
      return elements.get(selector);
    },
    body: { classList: { add() {} } },
  };
  const window: any = {};
  runInNewContext(script, { document, window, location: { search }, URLSearchParams,
    Date: { now: () => now }, setInterval: (fn: () => void) => timers.push(fn), clearInterval() {} });
  return { element: document.querySelector, render: window.renderShell,
    advance(seconds: number) { now += seconds * 1000; timers.at(-1)?.(); } };
}

test("only the missing service offers installation; stopped starts without an install command", () => {
  const page = shell("?state=not_installed");
  expect(page.element("#command").value).toBe("pacer service install");
  expect(page.element("#install").hidden).toBe(false);
  page.render({ page: "stopped" });
  expect(page.element("h1").textContent).toBe("pacer stopped");
  expect(page.element("#start").hidden).toBe(false);
  expect(page.element("#install").hidden).toBe(true);
  expect(page.element("#command").value).toBe("");
  expect(page.element("#retry").hidden).toBe(true);
});

test("busy preview shows consent, a live timer, and no install action", () => {
  const page = shell("?state=busy&prompt=1&for=14");
  expect(page.element("h1").textContent).toBe("pacer is busy");
  expect(page.element("#message").textContent).toContain("Click Allow");
  expect(page.element("#elapsed").textContent).toBe("for 14 s");
  page.advance(2);
  expect(page.element("#elapsed").textContent).toBe("for 16 s");
  expect(page.element("#command").value).toBe("");
  expect(page.element("#install").hidden).toBe(true);
  expect(page.element("#restart").hidden).toBe(true);
});

test("inconclusive consent uses likely-cause copy; restart appears after 30 seconds", () => {
  const page = shell("?state=busy&for=30");
  expect(page.element("#message").textContent).toContain("usually means");
  expect(page.element("#restart").hidden).toBe(false);
  page.render({ page: "busy", macos: false, restart: false, seconds: 0 });
  expect(page.element("#message").textContent).not.toContain("macOS");
  expect(page.element("#restart").hidden).toBe(true);
  page.render({ page: "starting" });
  expect(page.element("h1").textContent).toBe("Starting pacer…");
  expect(page.element("#elapsed").hidden).toBe(true);
  expect(page.element("#command").value).toBe("");
});

test("shell uses the server page's current design tokens", () => {
  const tokens = readFileSync(new URL("../app/src/ds/tokens.css", import.meta.url), "utf8");
  const css = readFileSync(new URL("../desktop/ui/shell.css", import.meta.url), "utf8");
  expect(css.startsWith(tokens)).toBe(true);
});
