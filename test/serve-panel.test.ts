import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { MANAGED_MARKER, pluginDir } from "../src/plugin/install";
import { emptySnapshot } from "../src/link/envelope";
import { createManagedPanelWriter, writeManagedPanel } from "../src/serve/panel";
import { latestPath } from "../src/link/paths";
import { PANEL_OWNER_MARKER, serveOwnsPanel } from "../src/plugin/panel-owner";
import { startServer } from "../src/serve/http";

function fixture(managed = true) {
  const ctx = fakeCtx();
  ctx.env = { HOME: ctx.home, PACER_HOME: ctx.pacerHome, PACER_NO_UPDATE_CHECK: "1" };
  const root = pluginDir(ctx), path = join(root, "panel/live.html");
  mkdirSync(join(root, "panel"), { recursive: true });
  if (managed) writeFileSync(join(root, MANAGED_MARKER), "{}");
  return { ctx, root, path };
}
const view = { nowS: 100, reachable: true, transport: "http" as const };

for (const managed of [true, false]) test(`serve writes a status page only for a managed plugin (${managed})`, async () => {
  const { ctx, path } = fixture(managed);
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  try {
    for (let i = 0; i < 200 && !existsSync(path); i++) await Bun.sleep(20);
    expect(existsSync(path)).toBe(managed);
    if (managed) {
      const html = readFileSync(path, "utf8");
      expect(html).toContain("Live · updated");
      expect(html).toContain("Setup");
      expect(html).not.toContain("<script");
      // Snapshot refreshes must preserve the file until visible data changes.
      const inode = statSync(path).ino;
      await Bun.sleep(2200);
      expect(statSync(path).ino).toBe(inode);
      writeFileSync(latestPath(ctx), JSON.stringify({ ...emptySnapshot(), at: 101, alerts: [{ key: "new", title: "Snapshot changed", body: "New data", level: "warn", at: 101 }] }));
      for (let i = 0; i < 250 && !readFileSync(path, "utf8").includes("Snapshot changed"); i++) await Bun.sleep(20);
      expect(readFileSync(path, "utf8")).toContain("Snapshot changed");
    }
  } finally { server.stop(); }
}, 15000);

test("identical input and clock ticks do not rewrite; changed snapshots are throttled then written", () => {
  const { ctx, path } = fixture();
  let now = 0;
  const writer = createManagedPanelWriter(ctx, { nowMs: () => now });
  const snapshot = { ...emptySnapshot(), at: 100 };
  writer.refresh(snapshot, view);
  const first = statSync(path).ino;
  now = 1000;
  const changed = { ...snapshot, alerts: [{ key: "a", title: "Fresh alert", body: "Changed", level: "warn" as const, at: 101 }] };
  writer.refresh(changed, view);
  expect(readFileSync(path, "utf8")).not.toContain("Fresh alert");
  now = 2000;
  writer.refresh(snapshot, { ...view, nowS: 999999 });
  expect(statSync(path).ino).toBe(first);
  writer.refresh(changed, view);
  expect(readFileSync(path, "utf8")).toContain("Fresh alert");
  expect(statSync(path).ino).not.toBe(first);
});

test("setup and update changes rewrite without a snapshot change", () => {
  const { ctx, path } = fixture();
  let now = 0;
  const writer = createManagedPanelWriter(ctx, { nowMs: () => now });
  writer.refresh(emptySnapshot(), view);
  now = 2000;
  writer.refresh(emptySnapshot(), { ...view, setup: { checkedAt: 1, complete: false,ready:false,items: [{ id: "binary", title: "Install binary", required: true, status: "pending" }] } });
  expect(readFileSync(path, "utf8")).toContain("Install binary");
  now = 4000;
  writer.refresh(emptySnapshot(), { ...view, updates: { cli: "0.2.2", plugin: "0.2.2", latest: "0.3.0", available: true } });
  expect(readFileSync(path, "utf8")).toContain("Update available: 0.3.0");
});

test("refuses arbitrary destinations and symlinked panel folders", () => {
  const { ctx, root } = fixture();
  const outside = join(ctx.home, "outside.html");
  expect(() => writeManagedPanel(ctx, outside, "bad")).toThrow("refused");
  expect(existsSync(outside)).toBe(false);
  const other = fixture();
  const escape = join(other.root, "escape");
  symlinkSync(ctx.home, escape);
  expect(() => writeManagedPanel(other.ctx, join(escape, "live.html"), "bad")).toThrow("refused");
  // A lexically correct path must also stay inside the managed directory.
  const linked = fakeCtx();
  mkdirSync(pluginDir(linked), { recursive: true });
  writeFileSync(join(pluginDir(linked), MANAGED_MARKER), "{}");
  symlinkSync(ctx.home, join(pluginDir(linked), "panel"));
  expect(() => writeManagedPanel(linked, join(pluginDir(linked), "panel/live.html"), "bad")).toThrow("refused");
  expect(existsSync(join(ctx.home, "live.html"))).toBe(false);
});

test("write failures log one line and never throw", () => {
  const { ctx, path } = fixture();
  mkdirSync(path);
  const lines: string[] = [];
  const writer = createManagedPanelWriter(ctx, { log: line => lines.push(line) });
  expect(() => writer.refresh(emptySnapshot(), view)).not.toThrow();
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("\n");
});


test("ownership stays fresh without rewriting identical HTML", () => {
  const { ctx, root, path } = fixture();
  let now = 0;
  const writer = createManagedPanelWriter(ctx, { nowMs: () => now });
  const read = (p: string) => readFileSync(p, "utf8");
  writer.refresh(emptySnapshot(), view);
  const inode = statSync(path).ino;
  expect(serveOwnsPanel(root, read, 59)).toBe(true);
  expect(serveOwnsPanel(root, read, 60)).toBe(false);
  expect(serveOwnsPanel(root, read, -1)).toBe(false);
  now = 15000;
  writer.refresh(emptySnapshot(), view);
  expect(statSync(path).ino).toBe(inode);
  expect(JSON.parse(read(join(root, PANEL_OWNER_MARKER))).at).toBe(15);
  expect(serveOwnsPanel(root, read, 60)).toBe(true);
});

for (const managed of [true, false]) test(`writer requires the managed marker (${managed})`, () => {
  const { ctx, path } = fixture(managed);
  createManagedPanelWriter(ctx).refresh(emptySnapshot(), view);
  expect(existsSync(path)).toBe(managed);
});
