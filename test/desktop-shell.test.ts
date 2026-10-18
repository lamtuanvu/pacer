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

test("recoverable states show only automatic starting status", () => {
  for (const state of ["not_installed", "stopped", "busy", "starting", "ready", "unavailable", "startFailed"]) {
    const page = shell(`?state=${state}`);
    expect(page.element("h1").textContent).toBe("Starting pacer…");
    expect(page.element("#message").hidden).toBe(true);
    expect(page.element("#privacy").hidden).toBe(true);
  }
  const html = readFileSync(new URL("../desktop/ui/index.html", import.meta.url), "utf8");
  expect(html).not.toMatch(/Try again|Start pacer|Restart pacer|pacer service install|id="command"/);
});

test("permission preview uses only the basename and an OS settings link", () => {
  const page = shell("?state=permission&path=/Volumes/External/Project");
  expect(page.element("#message").textContent).toBe("macOS needs your permission for pacer to read Project. Click Allow in the macOS dialog.");
  expect(page.element("#privacy").hidden).toBe(false);
  const html = readFileSync(new URL("../desktop/ui/index.html", import.meta.url), "utf8");
  expect(html).toContain('href="x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"');
  page.render({ page: "permission" });
  expect(page.element("#message").textContent).toContain("your external drive");
  page.render({ page: "starting" });
  expect(page.element("#privacy").hidden).toBe(true);
  expect(page.element("#message").hidden).toBe(true);
});

test("consent detection preview and incompatible installs have no recovery buttons", () => {
  expect(shell("?state=busy&prompt=1").element("#message").textContent).toContain("Click Allow");
  for (const state of ["oldService", "oldApp", "protocol"]) {
    const page = shell(`?state=${state}`);
    expect(page.element("#message").textContent).toContain("Install");
    expect(page.element("#privacy").hidden).toBe(true);
  }
});

test("shell uses the server page's current design tokens", () => {
  const tokens = readFileSync(new URL("../app/src/ds/tokens.css", import.meta.url), "utf8");
  const css = readFileSync(new URL("../desktop/ui/shell.css", import.meta.url), "utf8");
  expect(css.startsWith(tokens)).toBe(true);
});
