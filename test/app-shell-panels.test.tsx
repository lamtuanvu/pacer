import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { panelSurfaces } from "../app/src/shell/panels/WorkPanels";
const browserPath = process.env.PACER_TEST_BROWSER;
const browserTest = test.skipIf(!browserPath);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  if (!browserPath) return;
  const build = await Bun.build({
    entrypoints: ["test/fixtures/ui/shell-panels-browser.tsx"],
    target: "browser",
  });
  if (!build.success) throw new AggregateError(build.logs);
  const script = await build.outputs[0]!.text();
  const css = (
    await Promise.all(
      [
        "app/src/ds/tokens.css",
        "app/src/ds/components.css",
        "app/src/styles.css",
      ].map((path) => Bun.file(path).text()),
    )
  ).join("\n");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        `<style>${css}</style><div id="root"></div><script type="module">${script}</script>`,
        { headers: { "Content-Type": "text/html" } },
      ),
  });
  browser = await chromium.launch({
    executablePath: browserPath!,
    headless: true,
  });
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
test("task-only plugin panels require a selected task", () => {
  const surface = { surface: "panelTabs", context: "task" } as any;
  expect(panelSurfaces([surface])).toEqual([]);
  expect(panelSurfaces([surface], "t-1")).toEqual([surface]);
});
browserTest(
  "scope filtering, agent destination, task selection, tabs and plugin visibility work",
  async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(server.url.toString());
    await page.getByRole("button", { name: "Toggle left panel", exact: true }).click();
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    const scope = page.getByRole("complementary", { name: "Scope" });
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    await scope.getByRole("link", { name: /acme\/api/ }).waitFor();
    await scope.getByRole("link", { name: /acme\/api/ }).click();
    expect(new URLSearchParams(page.url().split("?")[1]).get("repo")).toBe(
      "github.com/acme/api",
    );
    await inspector
      .getByText("Add SSH keepalive to remote runs", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Select another task" }).click();
    await inspector
      .getByText("Split the settings page into sections", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Clear selection" }).click();
    await inspector.getByText("Select a task to see its details.").waitFor();
    const before = await page.evaluate(() => (window as any).panelCalls.filter((row: any) => row.op === "task.get").length);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as any).panelCalls.filter((row: any) => row.op === "task.get").length)).toBe(before);
    expect(await inspector.getByText("Loading task…").count()).toBe(0);
    expect(await inspector.getByRole("link", { name: "Add SSH keepalive to remote runs" }).getAttribute("href")).toContain("#/tasks/t-0420");
    await page.getByRole("button", { name: "Select another task" }).click();
    await inspector.getByRole("tab", { name: "Task", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    expect(
      await inspector
        .getByRole("tab", { name: "Agents", exact: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(await inspector.getByRole("link").count()).toBeGreaterThan(0);
    await inspector.getByRole("button", { name: /more tabs/ }).click();
    await inspector.getByRole("menuitem", { name: /Plugin 2/ }).click();
    await inspector.getByText("Content for panel-2").waitFor();
    await inspector
      .getByRole("button", { name: "Add a panel from a plugin" })
      .click();
    await inspector
      .getByRole("button", { name: "Plugin 4", exact: true })
      .click();
    await inspector.getByText("Content for panel-4").waitFor();
    const calls = await page.evaluate(() => (window as any).panelCalls);
    expect(
      calls.find((row: any) => row.op === "plugin.ui.visibility").params,
    ).toEqual({
      plugin: "fixture",
      surface: "panelTab",
      id: "panel-4",
      visible: true,
      expect_rev: 7,
    });
    await scope.getByRole("link", { name: /Codex/ }).first().click();
    await page.waitForURL(/settings\/executors/);
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-details]")
          ?.getAttribute("aria-expanded") === "true",
    );
    await page.close();
  },
);
browserTest(
  "top bar toggles persist independently for Dispatch and Tasks across reload",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(server.url.toString());
    await page.getByRole("heading", { name: "Dispatch" }).waitFor();
    expect(await page.getByRole("complementary", { name: "Scope" }).count()).toBe(0);
    expect(await page.getByRole("complementary", { name: "Inspector" }).count()).toBe(0);
    expect(await page.evaluate(() => (window as any).panelCalls.filter((row: any) => row.op === "task.get"))).toEqual([]);
    await page.getByRole("button", { name: "Toggle left panel", exact: true }).click();
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    await page.getByRole("complementary", { name: "Inspector" }).waitFor();
    await page.reload();
    await page.getByRole("complementary", { name: "Scope" }).waitFor();
    await page.getByRole("complementary", { name: "Inspector" }).waitFor();
    const otherWindow = await page.context().newPage();
    await otherWindow.goto(server.url.toString());
    await otherWindow.getByRole("heading", { name: "Dispatch" }).waitFor();
    expect(await otherWindow.getByRole("complementary", { name: "Scope" }).count()).toBe(0);
    expect(await otherWindow.getByRole("complementary", { name: "Inspector" }).count()).toBe(0);
    await otherWindow.close();
    await page.getByRole("button", { name: "Toggle left panel", exact: true }).click();
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    await page.evaluate(() => {
      location.hash = "#/tasks";
    });
    await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
    expect(await page.getByRole("complementary", { name: "Scope" }).count()).toBe(0);
    expect(await page.getByRole("complementary", { name: "Inspector" }).count()).toBe(0);
    await page.evaluate(() => {
      location.hash = "#/";
    });
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Scope"]'),
    );
    await page.reload();
    await page.getByRole("heading", { name: "Dispatch" }).waitFor();
    expect(
      await page.getByRole("complementary", { name: "Inspector" }).count(),
    ).toBe(0);
    await page.close();
  },
);

browserTest(
  "panel-only plugins do not offer a visibility write without a revision read",
  async () => {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    await page.goto(`${server.url}?no-settings`);
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    await inspector.getByRole("tab", { name: /Plugin 0/ }).waitFor();
    expect(
      await inspector
        .getByRole("button", { name: "Add a panel from a plugin" })
        .count(),
    ).toBe(0);
    await inspector.getByRole("tab", { name: /Plugin 0/ }).click();
    await inspector.getByText("Content for panel-0").waitFor();
    await page.close();
  },
);

browserTest("unselected and empty task snapshots never issue task reads", async () => {
  for (const query of ["unselected", "no-tasks"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${server.url}?${query}`);
      await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
      const inspector = page.getByRole("complementary", { name: "Inspector" });
      await inspector.getByText("Select a task to see its details.").waitFor();
      if (query === "unselected") {
        // Fixture order is reversed: choose by update time, never by list position.
        expect(await inspector.getByRole("link", { name: "Add SSH keepalive to remote runs" }).getAttribute("href")).toBe("#/tasks/t-0420");
      } else expect(await inspector.getByRole("link").count()).toBe(0);
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => (window as any).panelCalls.filter((row: any) => row.op === "task.get"))).toEqual([]);
      expect(await inspector.getByText("Loading task…").count()).toBe(0);
    } finally { await page.close(); }
  }
});
