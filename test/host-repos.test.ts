import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { callOp } from "../src/api/ops";
import { loadStrategy } from "../src/config/strategy";
import { setup } from "../src/remote/hosts";
import type { Job } from "../src/jobs/registry";
import { fakeCtx } from "./helpers";

function fixture() {
  const ctx = fakeCtx(), remote: string[] = [];
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, team: { kind: "codex", home: "~/.codex-team" } },
    planner: "claude-code", hosts: { devbox: { ssh: "devbox", repos: { "github.com/acme/api": "~/src/api" } } },
    routing: [{ default: ["codex"] }],
  }));
  let exists = false;
  ctx.run = async argv => {
    if (argv[0] === "git") return { code: 0, stderr: "", stdout: argv.includes("get-url") ? "https://github.com/acme/api.git" : argv.includes("user.name") ? "Test User" : "test@example.invalid" };
    const cmd = argv.at(-1)!;
    remote.push(cmd);
    if (cmd.endsWith("clone https://github.com/acme/api.git")) exists = true;
    const stdout = cmd.includes("command -v codex") ? "git=git version 2.43.0\nsetsid=/bin/setsid\nscript=script from util-linux 2.40\ntail=/usr/bin/tail\n" : exists ? "exists=1\ngit=1\norigin=https://github.com/acme/api.git\nname=Test User\nemail=test@example.invalid\n" : "exists=0\n";
    return { code: 0, stderr: "", stdout: `__PACER_BEGIN__\n${stdout}` };
  };
  return { ctx, remote };
}

test("repo map normalizes canonical keys and rejects incomplete keys without editing", async () => {
  const { ctx } = fixture();
  await callOp(ctx, "host.repo.map", { alias: "devbox", key: "GitHub.com/Acme/API", path: "~/code/api" });
  expect(loadStrategy(ctx).hosts.devbox.repos).toEqual({ "github.com/acme/api": "~/code/api" });
  const before = readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8");
  await expect(callOp(ctx, "host.repo.map", { alias: "devbox", key: "acme/api", path: "~/api" })).rejects.toMatchObject({ code: "invalid_input", hint: expect.stringContaining("host/owner/repo") });
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toBe(before);
});

test("repo setup requires consent before any SSH and runs clone, identity, check as job steps", async () => {
  const { ctx, remote } = fixture();
  await expect(callOp(ctx, "host.repo.setup", { alias: "devbox", key: "github.com/acme/api" })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(setup(ctx, "devbox", ctx.home, { consent: false })).rejects.toMatchObject({ code: "invalid_input" });
  expect(remote).toEqual([]);
  const { job } = await callOp(ctx, "host.repo.setup", { alias: "devbox", key: "github.com/acme/api", consent: true }) as { job: Job };
  expect(job.state).toBe("passed");
  expect(job.steps.map(s => [s.name, s.state])).toEqual([["Clone", "passed"], ["Set identity", "passed"], ["Check", "passed"]]);
  const clone = remote.findIndex(c => c.endsWith("clone https://github.com/acme/api.git"));
  const identity = remote.findIndex(c => c.includes('config --local user.name "$2"'));
  expect(clone).toBeGreaterThanOrEqual(0);
  expect(identity).toBeGreaterThan(clone);
  expect(remote.slice(identity + 1).some(c => c.includes("command -v codex"))).toBe(true);
});

test("repo setup can skip clone and identity and reports a failed check", async () => {
  const { ctx } = fixture();
  const { job } = await callOp(ctx, "host.repo.setup", { alias: "devbox", key: "github.com/acme/api", consent: true, clone: false, identity: false }) as { job: Job };
  expect(job.state).toBe("failed");
  expect(job.steps.map(s => s.state)).toEqual(["skipped", "skipped", "failed"]);
});

test("host account folder returns a login command without connecting or logging in", async () => {
  const { ctx, remote } = fixture();
  expect(await callOp(ctx, "host.account.add", { alias: "devbox", account: "team", home: "~/.codex-team" })).toEqual({ command: "CODEX_HOME=~/.codex-team codex login" });
  expect(loadStrategy(ctx).hosts.devbox.accounts.team).toEqual({ home: "~/.codex-team" });
  expect(remote).toEqual([]);
});

test("a clone failure fails its step and prevents identity setup", async () => {
  const { ctx, remote } = fixture(), run = ctx.run;
  ctx.run = async (...args) => {
    const result = await run(...args);
    return args[0].at(-1)?.endsWith("clone https://github.com/acme/api.git") ? { ...result, code: 1 } : result;
  };
  const { job } = await callOp(ctx, "host.repo.setup", { alias: "devbox", key: "github.com/acme/api", consent: true }) as { job: Job };
  expect(job.state).toBe("failed");
  expect(job.steps.map(s => s.state)).toEqual(["failed", "skipped", "skipped"]);
  expect(remote.some(c => c.includes('config --local user.name "$2"'))).toBe(false);
});

test("an existing checkout skips clone and a second setup still checks identity", async () => {
  const { ctx } = fixture();
  const params = { alias: "devbox", key: "github.com/acme/api", consent: true };
  await callOp(ctx, "host.repo.setup", params);
  const { job } = await callOp(ctx, "host.repo.setup", params) as { job: Job };
  expect(job.state).toBe("passed");
  expect(job.steps.map(s => s.state)).toEqual(["skipped", "passed", "passed"]);
});
