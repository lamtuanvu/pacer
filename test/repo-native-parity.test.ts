import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx, tmpDir } from "./helpers";

const root = join(import.meta.dir, "..");

function nativeResult(home: string, op: string, params: unknown, bridgeResult?: unknown) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
  );
  const driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
  const input = bridgeResult === undefined
    ? `{"op":${JSON.stringify(op)},"params":${JSON.stringify(params)},"home":${JSON.stringify(home)},"now":1700000000}\n`
    : `{"op":${JSON.stringify(op)},"params":${JSON.stringify(params)},"home":${JSON.stringify(home)},"now":1700000000,"bridgeResult":${JSON.stringify(bridgeResult)}}\n`;
  return JSON.parse(execFileSync(driver, [], { input }).toString());
}

function seedRegistry(home: string) {
  const state = join(home, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "repos.json"),
    JSON.stringify({ "/a": { key: "one", path: "/a", lastUsed: 1 }, "/b": { key: "two", path: "/b", lastUsed: 2 } }),
    { mode: 0o600 },
  );
  writeFileSync(join(state, "repo-paths.json"), JSON.stringify({ "/alias-a": "/a", "/alias-b": "/b" }), { mode: 0o600 });
}

test("native repo.remove matches TypeScript on a supported registry", async () => {
  const tsHome = tmpDir();
  const nativeHome = tmpDir();
  seedRegistry(tsHome);
  seedRegistry(nativeHome);
  const ts = await callOp(fakeCtx({ home: tsHome, pacerHome: tsHome, now: 1_700_000_000 }), "repo.remove", { key: "one" });
  expect(nativeResult(nativeHome, "repo.remove", { key: "one" })).toEqual({ result: ts });
});

test("native repo.list strips unknown params like TypeScript", async () => {
  const home = tmpDir();
  mkdirSync(home, { recursive: true });
  const ts = await callOp(fakeCtx({ home, pacerHome: home, now: 1_700_000_000 }), "repo.list", { extra: true });
  expect(nativeResult(home, "repo.list", {})).toEqual({ result: [] });
  expect(nativeResult(home, "repo.list", { extra: true })).toEqual({ result: ts });
});
