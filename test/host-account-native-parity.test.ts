import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { callOp } from "../src/api/ops";
import { loadStrategy } from "../src/config/strategy";
import { fakeCtx, tmpDir } from "./helpers";

const root = join(import.meta.dir, "..");

const strategyYaml = {
  accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, team: { kind: "codex", home: "~/.codex-team" } },
  planner: "claude-code",
  hosts: { devbox: { ssh: "devbox", repos: {} } },
  routing: [{ default: ["codex"] }],
};

let nativeDriver: string;
function nativeAccountAdd(home: string, params: Record<string, string>) {
  if (!nativeDriver) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root });
    const metadata = JSON.parse(
      execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
    );
    nativeDriver = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  const bin = nativeDriver;
  const input = `{"op":"host.account.add","params":${JSON.stringify(params)},"home":${JSON.stringify(home)},"now":1700000000}\n`;
  return JSON.parse(execFileSync(bin, [], { input }).toString());
}

function seedHome(pacerHome: string, accounts = strategyYaml.accounts) {
  mkdirSync(pacerHome, { recursive: true });
  writeFileSync(join(pacerHome, "strategy.yaml"), stringify({ ...strategyYaml, accounts }), { mode: 0o600 });
}

test("native host.account.add matches TypeScript YAML and login command", async () => {
  const pacerHome = tmpDir();
  seedHome(pacerHome);
  const ctx = fakeCtx({ home: pacerHome, pacerHome });
  const params = { alias: "devbox", account: "team", home: "~/.codex-team" };
  const ts = await callOp(ctx, "host.account.add", params);
  const native = nativeAccountAdd(pacerHome, params);
  expect(native.result).toEqual(ts);
  expect(loadStrategy(ctx).hosts.devbox.accounts!.team).toEqual({ home: "~/.codex-team" });
  expect(readFileSync(join(pacerHome, "strategy.yaml"), "utf8")).toContain("~/.codex-team");
});

test("native host.account.add rejects unknown accounts like TypeScript", async () => {
  const pacerHome = tmpDir();
  seedHome(pacerHome);
  const ctx = fakeCtx({ home: pacerHome, pacerHome });
  const params = { alias: "devbox", account: "missing", home: "~/.codex-team" };
  await expect(callOp(ctx, "host.account.add", params)).rejects.toMatchObject({
    code: "invalid_input",
    message: "host account must be a configured codex or claude account",
  });
  const native = nativeAccountAdd(pacerHome, params);
  expect(native.error).toMatchObject({
    code: "invalid_input",
    message: "host account must be a configured codex or claude account",
  });
});
