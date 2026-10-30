// A second turn, driven through runTask like the real runner, resumes the same native session.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runTask, type RunnerDeps } from "../src/tasks/runner";
import { runAttempt } from "../src/exec/direct";
import { validateStrategy } from "../src/config/strategy";
import { sendMessage } from "../src/messaging/send";
import type { Ctx } from "../src/types";

const CODEX = `#!/bin/sh
echo "$@" >> "$FAKE_LOG/codex-argv"
cat > "$FAKE_LOG/codex-stdin-$(wc -l < "$FAKE_LOG/codex-argv" | tr -d ' ')"
sid=""; out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
case "$*" in *"exec resume"*) for a in "$@"; do case "$a" in ????????-????-????-????-????????????) sid="$a";; esac; done;; esac
[ -n "$sid" ] || sid="0199aaaa-bbbb-cccc-dddd-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \\n')"
echo "session id: $sid" >&2
echo "CODEX REPORT" > "$out"
`;
const CLAUDE = `#!/bin/sh
n=$(ls "$FAKE_LOG" | grep -c '^claude-argv-')
echo "$@" > "$FAKE_LOG/claude-argv-$((n + 1))"
echo '{"type":"result","subtype":"success","result":"CLAUDE REPORT"}'
`;

function setup(planner: string) {
  const bin = tmpDir(), log = tmpDir();
  writeFileSync(join(bin, "codex"), CODEX);
  writeFileSync(join(bin, "claude"), CLAUDE);
  chmodSync(join(bin, "codex"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  const ctx = fakeCtx({ now: Date.now() / 1000, run: realRun, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, FAKE_LOG: log, CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const yaml = `planner: ${planner}\nproviders: {claude-code: {}, codex: {}}\nexecution: {launch_mode: headless}\n`;
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), yaml);
  const strategy = validateStrategy({ planner, providers: { "claude-code": {}, codex: {} }, execution: { launch_mode: "headless" } }, "/x");
  const spawned: Ctx[] = [];
  const deps: RunnerDeps = {
    loadStrategy: () => strategy,
    computeStatus: async c => ({ generatedAt: c.now, strategy: "default", planner, mode: "normal", disabled: false, calendarPace: true,
      providers: ["codex", "claude-code"].map(id => ({ id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false })),
      executors: { ranked: [], excluded: [] } }) as never,
    runAttempt,
    verifyRepo: async () => ({ files: "(no changes)" }),
    spawnRunner: (c) => { spawned.push(c); return 1; },
  };
  return { ctx, log, deps, spawned };
}

async function twoTurns(planner: string, executor: string) {
  const { ctx, log, deps, spawned } = setup(planner);
  const task = createTask(ctx, { brief: { goal: "write add(a,b)", repo: gitRepo() }, kind: "feature", requestedExecutor: executor, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.origin = "external:claude-code"; });
  const first = await runTask(ctx, task.id, deps);
  expect(first.state).toBe("done");
  const sid = first.run?.agentSession?.id;
  expect(sid).toBeTruthy();
  const sent = await sendMessage(ctx, { to: `task:${task.id}`, body: "now also add a comment" }, { spawnRunner: deps.spawnRunner });
  expect(sent.delivery).toBe("turn_started");
  expect(spawned.length).toBe(1);
  const second = await runTask(spawned[0]!, task.id, deps);
  expect(second.state).toBe("done");
  expect(second.run?.agentSession?.id).toBe(sid);
  expect(second.run?.turnResume).toBeUndefined();
  expect(second.worktree).toBe(first.worktree);
  return { log, sid: sid!, task: readTask(ctx, task.id)! };
}

test("a codex message turn resumes the same session through runTask", async () => {
  const { log, sid } = await twoTurns("claude-code", "codex");
  const argv = readFileSync(join(log, "codex-argv"), "utf8").trim().split("\n");
  expect(argv.length).toBe(2);
  expect(argv[0]).not.toContain("resume");
  expect(argv[1]).toContain("exec resume");
  expect(argv[1]).toContain(sid);
  const stdin = readFileSync(join(log, "codex-stdin-2"), "utf8");
  expect(stdin).toContain("now also add a comment");
  expect(stdin).not.toContain("write add(a,b)");
}, 30_000);

test("a claude-code message turn resumes the same session through runTask", async () => {
  const { log, sid } = await twoTurns("codex", "claude-code");
  expect(readdirSync(log).filter(f => f.startsWith("claude-argv-")).length).toBe(2);
  const argv = [1, 2].map(n => readFileSync(join(log, `claude-argv-${n}`), "utf8"));
  expect(argv[0]).toContain(`--session-id ${sid}`);
  expect(argv[1]).toContain(`--resume ${sid}`);
  expect(argv[1]).toContain("now also add a comment");
}, 30_000);
