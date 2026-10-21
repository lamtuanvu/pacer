import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { createBrowserAdapter } from "../scripts/live/control/browser";
import { dispatch } from "../scripts/live/control/dispatch";
import { existsSync } from "node:fs";
const executable = process.env.PACER_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const available = existsSync(executable);
(available ? test : test.skip)("browser controls actual DOM, rejects ambiguity and stale navigation", async () => {
  const service = Bun.serve({ port: 0, fetch: () => new Response('<h1>Test</h1><a href="/next">Next</a><label>Name<textarea id="name"></textarea></label><button>Save</button><button>Duplicate</button><button>Duplicate</button>', { headers: { "content-type": "text/html" } }) });
  const origin = `http://127.0.0.1:${service.port}`;
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  const context = await browser.newContext(); const page = await context.newPage(); await page.goto(origin);
  const adapter = createBrowserAdapter(context, origin);
  try {
    const targets = await adapter.targets(); expect(targets[0].surface).toBe("web");
    const input = await dispatch({ command: "act", surface: "web", action: { kind: "type", selector: { role: "textbox", name: "Name" }, text: "Tiếng Việt\nquoted" } }, adapter);
    expect(input.delivery).toBe("delivered");
    expect(await page.locator("textarea").inputValue()).toBe("Tiếng Việt\nquoted");
    expect((await dispatch({ command: "act", surface: "web", action: { kind: "click", selector: { name: "Duplicate", role: "button" } } }, adapter)).error?.code).toBe("ambiguous");
    const navigation = await dispatch({ command: "act", surface: "web", action: { kind: "click", selector: { role: "link", name: "Next" } } }, adapter);
    expect(navigation.outcome).toBe("ok"); expect(navigation.delivery).toBe("delivered");
    const original = await adapter.inspect((await adapter.targets())[0]);
    const save = original.elements.find(element => element.name === "Save")!;
    await page.getByRole("button", { name: "Save", exact: true }).evaluate(node => node.replaceWith(node.cloneNode(true)));
    const replacement = await dispatch({ command: "act", surface: "web", action: { kind: "click", ref: save.ref, revision: original.revision, generation: original.target.generation } }, adapter);
    expect(replacement.error?.code).toBe("stale_reference");
    const before = await adapter.inspect((await adapter.targets())[0]);
    await page.reload();
    const stale = await dispatch({ command: "act", surface: "web", action: { kind: "click", ref: before.elements[0].ref, revision: before.revision, generation: before.target.generation } }, adapter);
    expect(stale.error?.code).toBe("stale_reference");
    await page.goto("about:blank");
    expect((await dispatch({ command: "act", surface: "web", action: { kind: "type", text: "secret" } }, adapter)).error?.code).toBe("origin_changed");
  } finally { await browser.close(); service.stop(true); }
}, 60000);
