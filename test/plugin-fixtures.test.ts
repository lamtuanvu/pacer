// test/plugin-fixtures.test.ts
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIXTURES, installFixture } from "../conformance/install";

// Keep installed fixtures beneath the workspace so @pacer/plugin resolves.
const root = mkdtempSync(join(import.meta.dir, "..", "node_modules", ".plugin-fixtures-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The first Rust fixture installation builds its executable on a cold checkout.
test("fixtures install as executable plugin folders named by id", () => {
  mkdirSync(root, { recursive: true });
  for (const name of FIXTURES) installFixture(name, root);
  expect(statSync(join(root, "fx-good", "main.ts")).mode & 0o111).not.toBe(0);
  expect(statSync(join(root, "fx-bad", "pacer-plugin.json")).isFile()).toBe(true);
  expect(statSync(join(root, "fx-mismatch", "plugin.ts")).isFile()).toBe(true);
}, 120000);

test("the good fixture answers a handshake and a ping over stdio", async () => {
  mkdirSync(root, { recursive: true });
  const dir = installFixture("good", root);
  const child = spawn(join(dir, "main.ts"), [], { cwd: dir, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: process.env.HOME }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  const manifest = { id: "fx-good", version: "1.0.0", publisher: "pacer-conformance", host: "^1", entry: "main.ts", capabilities: [{ name: "log" }, { name: "config.get" }] };
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "plugin.hello", params: { protocol: "1.0.0", pacer: "0", manifest, config: {}, grants: ["log", "config.get"] } }) + "\n");
  const end = Date.now() + 8000;
  while (!out.includes('"id":1') && Date.now() < end) await Bun.sleep(20);
  child.kill("SIGTERM");
  expect(out).toContain('"contributes":[]');
}, 15000);
