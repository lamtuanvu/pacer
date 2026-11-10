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

// Only .pc-main-scroll scrolls: hidden ancestors (including .pc-work and .pc-main, which frame the page head)
// can still be scrolled by focus or scrollIntoView, which moved the whole app (top bar and rail) out of the window.
test("desktop ancestors of the work area clip instead of scrolling", () => {
  const css = read("../app/src/styles.css");
  expect(css).toContain("html[data-pacer-desktop],html[data-pacer-desktop] body,html[data-pacer-desktop] #app,html[data-pacer-desktop] .pc-desktop-connection,html[data-pacer-desktop] .pc-app,html[data-pacer-desktop] .pc-body,html[data-pacer-desktop] .pc-work,html[data-pacer-desktop] .pc-main{overflow:clip}");
  expect(css).not.toContain("html[data-pacer-desktop] .pc-body{overflow:hidden}");
  expect(css).toContain("html[data-pacer-desktop] .pc-main-scroll{overflow:auto;min-height:0}");
});

// The shell printed its own unstyled reconnecting line above the app's styled notice, under the macOS window controls.
test("the desktop shell leaves reconnecting to the surface notices and styles its warning", () => {
  const shell = read("../app/src/shell/DesktopConnection.tsx");
  expect(shell).not.toContain("Your workspace is kept here");
  expect(shell).not.toMatch(/<p role="status">/);
  expect(shell).toContain('<div className="connection-bar">');
  // The main window shows the warning in its live region below the top bar, not above it under the window controls.
  expect(read("../app/src/main.tsx")).toContain("<DesktopConnectionShell warning={false}>");
  expect(read("../app/src/shell/Layout.tsx")).toContain("desktopWarning ? <DesktopWarningBar warning={desktopWarning} />");
});
