import { expect, test } from "bun:test";
import { CHROME_SELECTORS } from "../app/src/ds/chrome";
const css = await Bun.file("app/src/ds/native.css").text();
const flat = css.replace(/\s+/g, "");

test("root never rubber-bands", () => {
  expect(flat).toContain("html,body{overscroll-behavior:none}");
});
test("every chrome selector is unselectable and uses the arrow cursor", () => {
  for (const s of CHROME_SELECTORS) expect(css).toContain(s);
  expect(flat).toMatch(/user-select:none/);
  expect(flat).toMatch(/-webkit-user-select:none/);
  expect(flat).toMatch(/cursor:default/);
});
test("content inside chrome stays selectable", () => {
  expect(flat).toMatch(/:is\([^)]*code[^)]*input[^)]*textarea[^)]*\[contenteditable[^)]*\)\{[^}]*user-select:text/);
});
test("in-app navigation inside chrome uses the arrow cursor", () => {
  expect(flat).toContain(".pc-settings-nav,.pc-segmented)a{cursor:default}");
});
test("nav links and UI images do not drag", () => {
  expect(flat).toContain("-webkit-user-drag:none");
});
test("the layer is appended last to app.css and tray.css", async () => {
  const build = await Bun.file("app/build.ts").text();
  expect(build.match(/src\/ds\/native\.css"\)\)\.text\(\)\]\.join\("\\n"\)/g)?.length).toBe(2);
});