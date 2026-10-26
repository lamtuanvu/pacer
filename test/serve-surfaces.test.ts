import { expect, spyOn, test } from "bun:test";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginProtocolSchema } from "../scripts/plugin-protocol-doc";
import { manifestSchema } from "../src/plugins/protocol";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";
import { writeNative } from "../src/plugins/write-native";
import { pluginRegistry } from "../src/plugins";

const base = { id: "fx-surface", version: "1.0.0", publisher: "test", host: "^1", entry: "main.ts", capabilities: [] };
const manifest = (dir: string, prefix = "fx") => ({ ...base, contributes: { surface: { prefix, dir } } });

test("published surface directory schema and runtime reject the same unsafe paths", () => {
  const schema = pluginProtocolSchema() as { $defs: { manifest: { properties: { contributes: { properties: { surface: { properties: { dir: { pattern: string } } } } } } } } };
  const pattern = schema.$defs.manifest.properties.contributes.properties.surface.properties.dir.pattern;
  expect(pattern).toBeString();
  const published = new RegExp(pattern);
  for (const dir of ["ui", "assets/ui", ".../assets", "a b/é"]) {
    expect(manifestSchema.safeParse(manifest(dir)).success).toBe(true);
    expect(published.test(dir)).toBe(true);
  }
  for (const dir of ["/tmp/ui", "../ui", "ui/../secret", "ui//assets", "ui\\secret", "C:\\secret", "C:/secret", ".", "", "ui/./assets", "ui/", "ui\0secret", "ui\nsecret"]) {
    expect(manifestSchema.safeParse(manifest(dir)).success).toBe(false);
    expect(published.test(dir)).toBe(false);
  }
  for (const prefix of ["Bad", "a/b", "", "x".repeat(33)])
    expect(manifestSchema.safeParse(manifest("ui", prefix)).success).toBe(false);
});

test("declaring a surface without a grant never exposes its HTML", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const dir = join(ctx.pacerHome, "plugins", "fx-surface");
  mkdirSync(join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify(manifest("ui")));
  writeFileSync(join(dir, "main.ts"), "");
  writeFileSync(join(dir, "ui", "index.html"), "<script>privilegedOperation()</script>");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const s = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${s.port}/app/plugins/fx/index.html`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("privilegedOperation");
  } finally { s.stop(); }
});

test("granted surface files have an opaque sandboxed document origin", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const dir = join(ctx.pacerHome, "plugins", "fx-surface");
  mkdirSync(join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify(manifest("ui")));
  writeFileSync(join(dir, "main.ts"), "");
  writeFileSync(join(dir, "ui", "index.html"), "<script src=\"./main.js\"></script>");
  writeFileSync(join(dir, "ui", "main.js"), "document.body.dataset.plugin = 'ready';");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  installed:\n    fx-surface: { version: 1.0.0, capabilities: [] }\n");
  const s = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  try {
    const url = `http://127.0.0.1:${s.port}/app/plugins/fx/index.html`;
    const auth = { authorization: `Bearer ${s.token}` };
    expect((await fetch(url)).status).toBe(401);
    const ok = await fetch(url, { headers: auth });
    expect(ok.status).toBe(200);
    expect(ok.url).toContain("/_s/s1.");
    expect(await ok.text()).toContain("main.js");
    expect(ok.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(ok.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const script = await fetch(url.replace("index.html", "main.js"), { headers: auth });
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await fetch(ok.url)).status).toBe(200);
    const tampered = ok.url.replace(/(s1\.[^.]+\.[^.]+\.)([a-f0-9])/, (_all, start: string, first: string) => start + (first === "0" ? "1" : "0"));
    expect((await fetch(tampered)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${s.port}/v3/ops/plugin.list`)).status).toBe(401);
    expect((await fetch(ok.url, { method: "POST" })).status).toBe(401);
    expect((await fetch(url, { method: "HEAD", headers: auth })).status).toBe(200);
    expect((await fetch(url, { method: "POST", headers: auth })).status).toBe(405);
    expect((await fetch(url.replace("fx/", "nope/"), { headers: auth })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${s.port}/app/plugins/fx/%2e%2e/strategy.yaml`, { headers: auth })).status).toBe(404);
    await pluginRegistry(ctx).disable(ctx, "fx-surface");
    expect((await fetch(ok.url)).status).toBe(401);
  } finally { await s.stop(); }
});

test("surface serving never follows a symlink outside its plugin folder", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const dir = join(ctx.pacerHome, "plugins", "fx-surface");
  mkdirSync(join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify(manifest("ui")));
  writeFileSync(join(dir, "main.ts"), "");
  writeFileSync(join(ctx.pacerHome, "secret.txt"), "private fixture");
  symlinkSync(join(ctx.pacerHome, "secret.txt"), join(dir, "ui", "secret.txt"));
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  installed:\n    fx-surface: { version: 1.0.0, capabilities: [] }\n");
  const s = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${s.port}/app/plugins/fx/secret.txt`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("private fixture");
  } finally { await s.stop(); }
});

test("surface file read stays on the opened directory when its path is swapped", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const dir = join(ctx.pacerHome, "plugins", "fx-surface");
  const ui = join(dir, "ui");
  const outside = join(ctx.pacerHome, "outside");
  mkdirSync(ui, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify(manifest("ui")));
  writeFileSync(join(dir, "main.ts"), "");
  writeFileSync(join(ui, "index.html"), "safe fixture");
  writeFileSync(join(outside, "index.html"), "outside secret");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  installed:\n    fx-surface: { version: 1.0.0, capabilities: [] }\n");
  const native = writeNative();
  const original = native.openAt.bind(native);
  let swapped = false;
  const spy = spyOn(native, "openAt").mockImplementation((fd, name, flags, mode) => {
    if (name === "index.html" && !swapped) {
      swapped = true;
      renameSync(ui, join(ctx.pacerHome, "moved-ui"));
      symlinkSync(outside, ui);
    }
    return original(fd, name, flags, mode);
  });
  const s = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${s.port}/app/plugins/fx/index.html`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("safe fixture");
    expect(swapped).toBe(true);
  } finally { spy.mockRestore(); await s.stop(); }
});
