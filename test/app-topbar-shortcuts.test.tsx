import { afterEach, expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TopBar } from "../app/src/shell/TopBar";

const platform = Object.getOwnPropertyDescriptor(globalThis.navigator, "platform");
afterEach(() => { if (platform) Object.defineProperty(globalThis.navigator, "platform", platform); else delete (globalThis.navigator as { platform?: string }).platform; });
const toggles = (value: string) => {
  Object.defineProperty(globalThis.navigator, "platform", { value, configurable: true });
  const html = renderToString(<TopBar title="Settings" planner={null} mode="" connected lastUpdate={null} now={0} onDelegate={() => {}}
    panels={{ left: { open: true, toggle: () => {} }, dock: { open: false, toggle: () => {} } }} />);
  return html;
};

test("the left panel toggle advertises the key the platform really binds", () => {
  expect(toggles("MacIntel")).toMatch(/aria-label="Toggle left panel"[^>]*aria-keyshortcuts="Meta\+B"|aria-keyshortcuts="Meta\+B"[^>]*aria-label="Toggle left panel"/);
  const other = toggles("Linux x86_64");
  expect(other).toMatch(/aria-label="Toggle left panel"[^>]*aria-keyshortcuts="Control\+B"|aria-keyshortcuts="Control\+B"[^>]*aria-label="Toggle left panel"/);
  // The terminal dock key is Ctrl-` everywhere.
  expect(toggles("MacIntel")).toContain('aria-keyshortcuts="Control+`"');
});
