import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "preact-render-to-string";
import { DesktopConnectionShell } from "../app/src/shell/DesktopConnection";

// The desktop wraps the app in a connection div between #app and the density wrapper.
// Without a height on it the app grows to its content and no screen scrolls.
test("the desktop connection wrapper carries the class that keeps the scroll height chain", () => {
  const host = globalThis as { __TAURI__?: unknown };
  const previous = host.__TAURI__;
  host.__TAURI__ = { core: { invoke: async () => null }, event: { listen: async () => () => {} } };
  try {
    const html = renderToString(<DesktopConnectionShell><div class="pc-density"><div class="pc-app" /></div></DesktopConnectionShell>);
    expect(html).toMatch(/^<div class="pc-desktop-connection"/);
  } finally {
    if (previous === undefined) delete host.__TAURI__; else host.__TAURI__ = previous;
  }
  const css = readFileSync(new URL("../app/src/styles.css", import.meta.url), "utf8");
  // Sized only while shown, so the hidden attribute still hides it before the service connects.
  expect(css).toContain("html[data-pacer-desktop] .pc-desktop-connection:not([hidden]){display:flex;flex-direction:column;height:100%;min-height:0}");
  expect(css).toContain("html[data-pacer-desktop] .pc-desktop-connection>.pc-density{flex:1 1 0;min-height:0}");
});
