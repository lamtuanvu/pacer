import { expect, test } from "bun:test";
test("setup items from the service open Overview's Setup, settings sections open Settings", async () => {
  const { uiHref } = await import("../app/src/data/actions");
  const { actionRoute } = await import("../app/src/tray/model");
  expect(uiHref({ view: "settings", section: "service" })).toBe("#/");
  expect(uiHref({ view: "settings", section: "accounts" })).toBe("#/settings/accounts");
  expect(actionRoute({ label: "Open settings", op: "ui.open", params: { view: "settings", section: "link" } } as never)).toBe("/");
  expect(actionRoute({ label: "Open settings", op: "ui.open", params: { view: "settings", section: "executors" } } as never)).toBe("/settings/executors");
});
