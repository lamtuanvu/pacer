import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginProtocolSchema } from "../scripts/plugin-protocol-doc";
import { manifestSchema } from "../src/plugins/protocol";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";

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

test("declaring a surface never exposes its HTML on the privileged app origin", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const dir = join(ctx.pacerHome, "plugins", "fx-surface");
  mkdirSync(join(dir, "ui"), { recursive: true });
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify(manifest("ui")));
  writeFileSync(join(dir, "main.ts"), "");
  writeFileSync(join(dir, "ui", "index.html"), "<script>privilegedOperation()</script>");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  installed:\n    fx-surface: { version: 1.0.0, capabilities: [] }\n");
  const s = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${s.port}/app/plugins/fx/index.html`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("privilegedOperation");
  } finally { s.stop(); }
});
