import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { terminal } from "../src/remote/hosts";
import { fakeCtx, tmpDir } from "./helpers";

const root = join(import.meta.dir, "..");

function decisionsLine(input: unknown) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--example", "decisions", "--locked"], { cwd: root });
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
  );
  const bin = join(metadata.target_directory, "debug/examples/decisions");
  return JSON.parse(execFileSync(bin, [], { input: JSON.stringify(input) + "\n", encoding: "utf8" }));
}

test("host.terminal SSH argv matches Rust terminal_ssh helper", async () => {
  const pacerHome = tmpDir();
  mkdirSync(pacerHome, { recursive: true });
  writeFileSync(
    join(pacerHome, "strategy.yaml"),
    stringify({
      accounts: { claude: { kind: "claude" }, codex: { kind: "codex" } },
      planner: "claude-code",
      hosts: { devbox: { ssh: "devbox", repos: {} } },
      routing: [{ default: ["codex"] }],
    }),
    { mode: 0o600 },
  );
  const ctx = fakeCtx({ home: pacerHome, pacerHome });
  let captured: { argv: string[]; title: string } | undefined;
  const capture = async (_ctx: unknown, options: { argv: string[]; title: string }) => {
    captured = options;
    return { opened: true, target: "none" as const, command: options.argv.join(" ") };
  };
  await terminal(ctx, "devbox", capture as typeof import("../src/terminal/open").openInTerminal);
  const rust = decisionsLine({ op: "host.terminal", alias: "devbox", ssh: "devbox", builtin: false });
  expect(rust).toEqual(captured);

  await terminal(ctx, "devbox", capture as typeof import("../src/terminal/open").openInTerminal, { builtin: true });
  const rustBuiltin = decisionsLine({ op: "host.terminal", alias: "devbox", ssh: "devbox", builtin: true });
  expect(rustBuiltin).toEqual(captured);
});
