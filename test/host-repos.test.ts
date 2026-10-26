import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const bin = join(ctx.home, "bin"), ssh = join(bin, "ssh"), sshLog = join(ctx.home, "ssh.log"), existsFlag = join(ctx.home, "checkout-exists");
  mkdirSync(bin, { recursive: true });
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sshLog}'\ncase "$*" in\n  *"__PACER_DONE__="*) nonce=$(printf '%s' "$*" | sed -n 's/.*__PACER_DONE__=\\([a-f0-9-]*\\).*/\\1/p'); printf '__PACER_BEGIN__\\n\\n__PACER_DONE__=%s\\n' "$nonce" ;;\n  *"command -v codex"*) printf '__PACER_BEGIN__\\ngit=git version 2.43.0\\nsetsid=/bin/setsid\\nscript=script from util-linux 2.40\\ntail=/usr/bin/tail\\n' ;;\n  *" check"*) if [ -f ${JSON.stringify(existsFlag)} ]; then printf '__PACER_BEGIN__\\nexists=1\\ngit=1\\norigin=https://github.com/acme/api.git\\nname=Test User\\nemail=test@example.invalid\\n'; else printf '__PACER_BEGIN__\\nexists=0\\n'; fi ;;\n  *) printf '__PACER_BEGIN__\\n' ;;\nesac\n`);
  chmodSync(ssh, 0o700);
  ctx.env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  ctx.which = name => name === "ssh" ? ssh : null;
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, team: { kind: "codex", home: "~/.codex-team" } },
    planner: "claude-code", hosts: { devbox: { ssh: "devbox", repos: { "github.com/acme/api": "~/src/api" } } },
    routing: [{ default: ["codex"] }],
  }));
  ctx.run = async argv => {
    if (argv[0] === "git") return { code: 0, stderr: "", stdout: argv.includes("get-url") ? "https://github.com/acme/api.git" : argv.includes("user.name") ? "Test User" : "test@example.invalid" };
    const cmd = argv.at(-1)!;
    remote.push(cmd);
    if (cmd.endsWith("clone https://github.com/acme/api.git")) writeFileSync(existsFlag, "");
    const stdout = cmd.includes("command -v codex") ? "git=git version 2.43.0\nsetsid=/bin/setsid\nscript=script from util-linux 2.40\ntail=/usr/bin/tail\n" : existsSync(existsFlag) ? "exists=1\ngit=1\norigin=https://github.com/acme/api.git\nname=Test User\nemail=test@example.invalid\n" : "exists=0\n";
    return { code: 0, stderr: "", stdout: `__PACER_BEGIN__\n${stdout}` };
  };
  return { ctx, remote, sshLog };
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
  const { ctx, remote, sshLog } = fixture();
  await expect(callOp(ctx, "host.repo.setup", { alias: "devbox", key: "github.com/acme/api" })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(setup(ctx, "devbox", ctx.home, { consent: false })).rejects.toMatchObject({ code: "invalid_input" });
  expect(remote).toEqual([]);
  const { job } = await callOp(ctx, "host.repo.setup", { alias: "devbox", key: "github.com/acme/api", consent: true }) as { job: Job };
  expect(job.state).toBe("passed");
  expect(job.steps.map(s => [s.name, s.state])).toEqual([["Clone", "passed"], ["Set identity", "passed"], ["Check", "passed"]]);
  const clone = remote.findIndex(c => c.endsWith("clone https://github.com/acme/api.git"));
  expect(clone).toBeGreaterThanOrEqual(0);
  expect(readFileSync(sshLog, "utf8")).toContain('config --local user.name "$2"');
  expect(readFileSync(sshLog, "utf8")).toContain("command -v codex");
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
  expect(existsSync(join(ctx.home, "ssh.log"))).toBe(false);
});

test("an existing checkout skips clone and a second setup still checks identity", async () => {
  const { ctx, sshLog } = fixture();
  const params = { alias: "devbox", key: "github.com/acme/api", consent: true };
  await callOp(ctx, "host.repo.setup", params);
  const { job } = await callOp(ctx, "host.repo.setup", params) as { job: Job };
  expect(job.state).toBe("passed");
  expect(job.steps.map(s => s.state)).toEqual(["skipped", "passed", "passed"]);
  expect(readFileSync(sshLog, "utf8").match(/config --local user.name "\$2"/g)).toHaveLength(2);
});
