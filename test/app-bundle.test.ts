import { expect, test } from "bun:test";
import { buildApp, generatedSource } from "../app/build";
import { APP_FILES, APP_VERSION } from "../src/app/assets.generated";
import pkg from "../package.json";

test("embedded app assets equal a fresh deterministic build", async () => {
  const files = await buildApp();
  expect(APP_VERSION).toBe(pkg.version);
  expect(APP_FILES).toEqual(files);
  expect(await Bun.file(new URL("../src/app/assets.generated.ts", import.meta.url)).text()).toBe(generatedSource(files));
});

test("app HTML uses external scripts and styles under the app CSP", async () => {
  const html = (await buildApp()).find(f => f.path === "index.html")!.text;
  expect(html).toContain('src="/app/app.js"');
  // The bundle is split into ES modules (the terminal loads lazily), so it must load as a module.
  expect(html).toMatch(/<script type="module" src="\/app\/app\.js"><\/script>/);
  expect(html).toContain('href="/app/app.css"');
  expect(html).not.toMatch(/<script\b[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i);
  expect(html).not.toMatch(/\son\w+\s*=/i);
  expect(html).not.toMatch(/\sstyle\s*=/i);
});

test("release refuses stale embedded app versions before compiling", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpDir } = await import("./helpers");
  const { buildRelease } = await import("../scripts/release/build");
  const root = tmpDir();
  mkdirSync(join(root, "src/app"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(root, "src/app/assets.generated.ts"), 'export const APP_VERSION = "0.0.0";');
  await expect(buildRelease({ root, targets: [] })).rejects.toThrow("run bun run app:build first");
});

test("app.js stays under the 60 KB gzip budget", async () => {
  const { APP_JS_BUDGET } = await import("../app/build");
  const appJs = (await buildApp()).find(f => f.path === "app.js")!.text;
  expect(APP_JS_BUDGET).toBe(60 * 1024);
  expect(Bun.gzipSync(appJs).byteLength).toBeLessThan(APP_JS_BUDGET);
});
