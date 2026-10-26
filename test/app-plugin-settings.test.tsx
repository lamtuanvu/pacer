import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { PluginRows, type PluginRow } from "../app/src/screens/settings/Plugins";
import { pluginStatus } from "../src/view-model/words";
import { initialState, reduceStore } from "../app/src/data/store";
import { resolveRoute, settingsPath } from "../app/src/router";
import { emptySnapshot } from "../src/link/envelope";

const installed: PluginRow = {
  id: "sample-panel", version: "1.0.0", publisher: "Example", tier: "commercial",
  bundled: false, enabled: true, state: "ready", contributes: ["surface"],
  expectedConsent: "a".repeat(64),
  capabilities: [{ name: "config.get" }], grant: { version: "1.0.0", capabilities: ["config.get"] },
  error: null, pid: 123, surface: { prefix: "sample", available: true },
};

test("Plugins is a Settings deep link with one navigation entry", async () => {
  expect(settingsPath("plugins")).toBe("/settings/plugins");
  expect(resolveRoute("#/settings/plugins")).toMatchObject({ name: "settings", section: "plugins" });
  const { SettingsPanel } = await import("../app/src/shell/SettingsPanel");
  const html = renderToString(<SettingsPanel route={{ name: "settings", section: "plugins", query: { repo: null, scope: null } }} counts={null}/>);
  expect(html).toMatch(/<a(?=[^>]*settings\/plugins)(?=[^>]*aria-current="page")[^>]*>/);
  expect(html.match(/settings\/plugins/g)).toHaveLength(1);
});

test("plugin rows offer only available actions and keep grants explicit", () => {
  const disabled: PluginRow = { ...installed, id: "disabled-panel", state: "disabled", enabled: false, surface: { prefix: "off", available: false } };
  const grant: PluginRow = { ...installed, id: "needs-permission", state: "needs_grant", enabled: false, grant: null, surface: null };
  const html = renderToString(<PluginRows plugins={[installed, disabled, grant]} busy={false} selected="sample-panel" onAction={() => {}} onOpen={() => {}}/>);
  expect(html).toContain("Allow and enable");
  expect(html).toContain("Close panel for sample-panel");
  expect(html).not.toContain("Open panel for disabled-panel");
  expect(html).toContain('sandbox="allow-scripts"');
  expect(html).not.toContain("allow-same-origin");
  expect(html).toContain('/app/plugins/sample/');
  expect(html).not.toContain("postMessage");
  expect(html).toContain("License status unavailable");
  expect(html).toContain("earlier permission needs review");
});

test("plugin status uses shared vocabulary and events refresh the Settings query", () => {
  expect(pluginStatus("needs_grant").label).toBe("Needs permission");
  const snapshot = { ...emptySnapshot(), seq: 1 };
  const state = reduceStore(initialState(), { type: "snapshot", snapshot });
  const next = reduceStore(state, { type: "event", event: { type: "plugin", seq: 2, at: 2, data: { id: "sample-panel", state: "disabled" } } });
  expect(next.invalidations.plugins).toBe(1);
  expect(next.snapshot?.seq).toBe(2);
  expect(reduceStore(next, { type: "event", event: { type: "plugin", seq: 2, at: 2, data: {} } })).toBe(next);
});
