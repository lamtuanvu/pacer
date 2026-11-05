import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// The desktop wraps the app in a connection div between #app and the density wrapper.
// Without a height on it the app grows to its content and no screen scrolls.
test("the desktop connection wrapper keeps the scroll height chain", () => {
  expect(read("../app/src/shell/DesktopConnection.tsx")).toContain('<div className="pc-desktop-connection" hidden={blocked}');
  const css = read("../app/src/styles.css");
  // Sized only while shown, so the hidden attribute still hides it before the service connects.
  expect(css).toContain("html[data-pacer-desktop] .pc-desktop-connection:not([hidden]){display:flex;flex-direction:column;height:100%;min-height:0}");
  expect(css).toContain("html[data-pacer-desktop] .pc-desktop-connection>.pc-density{flex:1 1 0;min-height:0}");
});

// Only .pc-work scrolls: hidden ancestors can still be scrolled by focus or scrollIntoView,
// which moved the whole app (top bar and rail) out of the window.
test("desktop ancestors of the work area clip instead of scrolling", () => {
  const css = read("../app/src/styles.css");
  expect(css).toContain("html[data-pacer-desktop],html[data-pacer-desktop] body,html[data-pacer-desktop] #app,html[data-pacer-desktop] .pc-desktop-connection,html[data-pacer-desktop] .pc-app,html[data-pacer-desktop] .pc-body{overflow:clip}");
  expect(css).not.toContain("html[data-pacer-desktop] .pc-body{overflow:hidden}");
});
