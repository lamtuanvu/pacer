import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  const ssh = join(ctx.home, "fake-ssh"), down = join(ctx.home, "down"), gate = join(ctx.home, "gate"),
    started = join(ctx.home, "started"), release = join(ctx.home, "release");
  writeFileSync(ssh, `#!/bin/sh\n[ ! -f ${JSON.stringify(down)} ] || exit 255\nif [ -f ${JSON.stringify(gate)} ]; then touch ${JSON.stringify(started)}; n=0; while [ ! -f ${JSON.stringify(release)} ] && [ "$n" -lt 500 ]; do sleep 0.01; n=$((n+1)); done; fi\nprintf '__PACER_BEGIN__\\nos=Linux\\narch=x86_64\\ngit=git version 2.43.0\\nsetsid=/bin/setsid\\nscript=script from util-linux 2.40\\ntail=/usr/bin/tail\\ncodex=${codex}\\nclaude=/bin/claude\\n'\n`);
  chmodSync(ssh, 0o755);
  ctx.which = name => name === "ssh" ? ssh : null;
  ctx.env.PATH = process.env.PATH;
  ctx.run = async () => ({ code: 0, stderr: "", stdout: "" });
  return { ctx, down, gate, started, release };
}

test("host.check passes job steps and stores parsed host facts", async () => {
  const { ctx } = fixture();
  const { job } = await callOp(ctx, "host.check", { alias: "devbox" }) as { job: Job };
  expect(job.state).toBe("passed");
  expect(job.steps.map(s => [s.name, s.state])).toEqual([
    ["ssh", "passed"], ["git", "passed"], ["setsid", "passed"], ["script", "passed"], ["tail", "passed"], ["codex", "passed"], ["claude", "passed"], ["account homes", "passed"],
  ]);
  expect(hosts.readHostCheck(ctx, "devbox")).toMatchObject({ at: ctx.now, ok: true,
    facts: { os: "Linux", arch: "x86_64", git: "2.43.0", setsid: "/bin/setsid", tools: { codex: "/bin/codex", claude: "/bin/claude" } } });
});

test("missing codex fails its job step and persists the failed check", async () => {
  const { ctx } = fixture("");
  const { job } = await callOp(ctx, "host.check", { alias: "devbox" }) as { job: Job };
  expect(job.state).toBe("failed");
  expect(job.steps.find(s => s.name === "codex")).toMatchObject({ state: "failed", detail: "codex not on login PATH" });
  expect(hosts.readHostCheck(ctx, "devbox")?.ok).toBe(false);
});

test("overlapping host checks share the same running job", async () => {
  const { ctx, gate, started, release } = fixture();
  writeFileSync(gate, "");
  const first = callOp(ctx, "host.check", { alias: "devbox" }) as Promise<{ job: Job }>;
  const until = Date.now() + 2000;
  while (!existsSync(started) && Date.now() < until) await Bun.sleep(10);
  expect(existsSync(started)).toBe(true);
  try {
    const second = await callOp(ctx, "host.check", { alias: "devbox" }) as { job: Job };
    expect(second.job.state).toBe("running");
    writeFileSync(release, "");
    expect((await first).job.id).toBe(second.job.id);
  } finally { writeFileSync(release, ""); await first; }
});

test("unreachable checks are stored and later steps are skipped", async () => {
  const { ctx, down } = fixture();
  writeFileSync(down, "");
  const { job } = await callOp(ctx, "host.check", { alias: "devbox" }) as { job: Job };
  expect(job.state).toBe("failed");
  expect(job.steps[0]).toMatchObject({ name: "ssh", state: "failed", detail: "unreachable" });
  expect(job.steps.slice(1).every(s => s.state === "skipped")).toBe(true);
  expect(hosts.readHostCheck(ctx, "devbox")).toMatchObject({ ok: false, at: ctx.now });
});
