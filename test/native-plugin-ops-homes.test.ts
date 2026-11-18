import { expect, test } from "bun:test";
import { linkSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { front, service, tsOwner } from "./native-plugin-ops-service";

// Linked and configured plugin homes, whose fixtures restart the service for every kind and side.

test.skipIf(!front)("linked settings reads and atomic replacement match TypeScript", async () => {
  for (const kind of ["symlink", "hardlink"]) {
    const results: unknown[] = [];
    for (const forward of ["", "*"]) {
      const s = await service(forward, "absolute", tsOwner);
      try {
        await s.post("plugin.enable", { id: "fx-ui", grant: true });
        const target = join(s.home, "settings-target.json"), name = join(s.state, "plugin-settings.json");
        const text = JSON.stringify({ "fx-ui": { rev: 7, values: { required: true }, hidden: ["activity:checklist"] } });
        writeFileSync(target, text, { mode: 0o600 });
        if (kind === "symlink") symlinkSync(target, name); else linkSync(target, name);
        const get = await s.post("plugin.settings.get", { plugin: "fx-ui" });
        expect(get.result?.rev, JSON.stringify(get)).toBe(7);
        results.push(get, await s.post("plugin.ui.list", {}));
        const save = await s.post("plugin.settings.set", { plugin: "fx-ui", values: { required: false }, expect_rev: 7 });
        expect(save.result?.rev).toBe(8); results.push(save);
        expect(readFileSync(target, "utf8")).toBe(text);
      } finally { await s.stop(); }
    }
    expect(results.slice(0, 3)).toEqual(results.slice(3));
  }
}, 60000);

test.skipIf(!front)("configured symlinked and relative homes match TypeScript settings writes", async () => {
  for (const kind of ["symlink", "relative", "relative-symlink"]) {
    const results: unknown[][] = [];
    for (const forward of ["", "*"]) {
      const s = await service(forward, kind, tsOwner), actual: unknown[] = [];
      try {
        const enable = await s.post("plugin.enable", { id: "fx-ui", grant: true });
        expect(enable.result?.state, JSON.stringify(enable)).toBe("idle"); actual.push(enable);
        const save = await s.post("plugin.settings.set", { plugin: "fx-ui", values: { required: true }, expect_rev: 0 });
        expect(save.result?.rev, JSON.stringify(save)).toBe(1); actual.push(save);
        const hidden = await s.post("plugin.ui.visibility", { plugin: "fx-ui", surface: "activity", id: "checklist", visible: false, expect_rev: 1 });
        expect(hidden.result?.rev, JSON.stringify(hidden)).toBe(2); actual.push(hidden);
        actual.push(await s.post("plugin.settings.get", { plugin: "fx-ui" }));
        const remove = await s.post("plugin.remove", { id: "fx-ui" });
        expect(remove.result?.removed, JSON.stringify(remove)).toBe(true); actual.push(remove);
        expect(JSON.parse(readFileSync(join(s.state, "plugin-settings.json"), "utf8"))["fx-ui"]).toBeUndefined();
        results.push(actual);
      } finally { await s.stop(); }
    }
    expect(results[0], kind).toEqual(results[1]);
  }
}, 60000);

test.skipIf(!front)("lock timeout names configured home rather than its canonical target", async () => {
  // Each side waits out the same lock timeout on its own home, so the two wait together.
  await Promise.all(["", "*"].map(async forward => {
    const s = await service(forward, "symlink", tsOwner);
    try {
      await s.post("plugin.enable", { id: "fx-ui", grant: true });
      writeFileSync(join(s.state, "orca/plugin-settings.lock"), "", { mode: 0o600 });
      const response = await fetch(`${s.base}/v3/ops/plugin.settings.set`, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ plugin: "fx-ui", values: {}, expect_rev: 0 }), signal: AbortSignal.timeout(25000) });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "internal", message: `timed out waiting for ${join(s.home, "linked/orca/plugin-settings.lock")}` } });
    } finally { await s.stop(); }
  }));
}, 60000);
