import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { callOp } from "../src/api/ops";
import * as hosts from "../src/remote/hosts";
import type { Job } from "../src/jobs/registry";
import { fakeCtx } from "./helpers";

function fixture(codex = "/bin/codex") {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" } }, planner: "claude-code",
    hosts: { devbox: { ssh: "devbox" } }, routing: [{ default: ["codex@devbox", "claude-code@devbox", "codex"] }],
  }));
  ctx.run = async argv => ({ code: 0, stderr: "", stdout: argv[0] === "ssh"
    ? `__PACER_BEGIN__\nos=Linux\narch=x86_64\ngit=git version 2.43.0\nsetsid=/bin/setsid\ncodex=${codex}\nclaude=/bin/claude\n` : "" });
  return ctx;
}

test("host.check passes job steps and stores parsed host facts", async () => {
  const ctx = fixture();
  const { job } = await callOp(ctx, "host.check", { alias: "devbox" }) as { job: Job };
  expect(job.state).toBe("passed");
  expect(job.steps.map(s => [s.name, s.state])).toEqual([
    ["ssh", "passed"], ["git", "passed"], ["setsid", "passed"], ["codex", "passed"], ["claude", "passed"], ["account homes", "passed"],
  ]);
  expect(hosts.readHostCheck(ctx, "devbox")).toMatchObject({ at: ctx.now, ok: true,
    facts: { os: "Linux", arch: "x86_64", git: "2.43.0", setsid: "/bin/setsid", tools: { codex: "/bin/codex", claude: "/bin/claude" } } });
});

test("missing codex fails its job step and persists the failed check", async () => {
  const ctx = fixture("");
  const { job } = await callOp(ctx, "host.check", { alias: "devbox" }) as { job: Job };
  expect(job.state).toBe("failed");
  expect(job.steps.find(s => s.name === "codex")).toMatchObject({ state: "failed", detail: "codex not on login PATH" });
  expect(hosts.readHostCheck(ctx, "devbox")?.ok).toBe(false);
});

test("overlapping host checks share the same running job", async () => {
  const ctx = fixture(), run = ctx.run;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  ctx.run = async (...args) => {
    if (args[0][0] === "ssh") { entered(); await gate; }
    return run(...args);
  };
  const first = callOp(ctx, "host.check", { alias: "devbox" }) as Promise<{ job: Job }>;
  await started;
  try {
    const second = await callOp(ctx, "host.check", { alias: "devbox" }) as { job: Job };
    expect(second.job.state).toBe("running");
    release();
    expect((await first).job.id).toBe(second.job.id);
  } finally { release(); await first; }
});

test("unreachable checks are stored and later steps are skipped", async () => {
  const ctx = fixture();
  ctx.run = async () => ({ code: 255, stdout: "", stderr: "unreachable" });
  const { job } = await callOp(ctx, "host.check", { alias: "devbox" }) as { job: Job };
  expect(job.state).toBe("failed");
  expect(job.steps[0]).toMatchObject({ name: "ssh", state: "failed", detail: "unreachable" });
  expect(job.steps.slice(1).every(s => s.state === "skipped")).toBe(true);
  expect(hosts.readHostCheck(ctx, "devbox")).toMatchObject({ ok: false, at: ctx.now });
});
