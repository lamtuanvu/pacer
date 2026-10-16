import { test, expect } from "bun:test";
import { pluginManifest } from "../orca-plugin/src/manifest";
import pkg from "../package.json";
test("manifest mirrors verified Orca rules and omits instructional contributions", async () => {
  const m = pluginManifest(pkg.version);
  for (const id of [m.id, m.publisher]) { expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/); expect(id.length).toBeLessThanOrEqual(64); expect(["__proto__", "prototype", "constructor"]).not.toContain(id); }
  expect(m.manifestVersion).toBe(1); expect(m.pluginApi).toBe(1); expect(m.version).toBe(pkg.version);
  expect(m.engines.orca).toMatch(/^>=\d+\.\d+\.\d+$/);
  const caps: string[] = m.capabilities.map(c => c.kind);
  expect([...caps].sort()).toEqual(["workspace:read", "notifications:show", "events:subscribe", "storage", "settings:own"].sort());
  for (const c of caps) expect(["workspace:read", "notifications:show", "events:subscribe", "storage", "settings:own", "secrets"]).toContain(c);
  expect(m.contributes.events).toEqual([]);
  expect(m.contributes.commands).toEqual([{id:"open",title:"pacer: Open",context:"global"}]);
  expect(m.contributes.panels[0].title).toBe("pacer");
  expect(m.main).toBeTruthy(); expect(caps).toContain("events:subscribe");
  for (const c of m.contributes.commands) expect(c.id).toMatch(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/);
  for (const p of m.contributes.panels) { expect(p.entry).not.toMatch(/^(?:\/|[a-z]+:)/i); expect(p.entry.split("/")).not.toContain(".."); }
  for (const k of ["agents", "keybindings", "vmRecipes", "languagePacks"]) expect(m.contributes).not.toHaveProperty(k);
  expect(await Bun.file("orca-plugin/dist/orca-plugin.json").json()).toEqual(m);
});
