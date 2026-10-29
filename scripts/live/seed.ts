import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registerWork } from "../../src/dispatch/work";
import { recordAttemptUsage } from "../../src/tokens/store";
import { createTask, updateTask } from "../../src/tasks/store";
import type { Ctx } from "../../src/types";
import type { AttemptTokens, TaskRecord } from "../../src/tasks/types";
import { atomicWrite, checkout } from "./core";

export function validateSeed(seed?: string): asserts seed is "ui" | undefined {
  if (seed !== undefined && seed !== "ui") throw Error(`Unknown seed: ${seed}; expected ui`);
}

/** Synthetic state only: no native credentials, executor launches or service installs. */
export function seedUi(root: string): void {
  const home = join(root, "home");
  const write = (path: string, data: string, mode = 0o600) => {
    const target = join(home, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    atomicWrite(target, data, mode);
  };
  const json = (path: string, data: unknown) => write(path, JSON.stringify(data, null, 2) + "\n");
  const now = Math.floor(Date.now() / 1000);
  const snapshot = JSON.parse(readFileSync(join(checkout, "test/fixtures/ui/snapshot.json"), "utf8"));
  const session = JSON.parse(readFileSync(join(checkout, "test/fixtures/ui/session.json"), "utf8"));
  const detail = JSON.parse(readFileSync(join(checkout, "test/fixtures/ui/task-get.json"), "utf8"));
  const accounts = ["team", "personal"];
  json("strategy.yaml", {
    planner: "codex#team",
    accounts: Object.fromEntries(accounts.map(name => [name, { kind: "codex", home: join(home, "accounts", name), usage: "quota" }])),
    runners: { "codex#team": {}, "codex#personal": {} },
    routing: [{ default: ["codex#personal"] }],
  });
  for (const [index, name] of accounts.entries()) {
    // Only an existence marker for loginIndicator; contains no authentication data.
    json(`accounts/${name}/auth.json`, {});
    const used = [28, 61][index];
    write(`accounts/${name}/sessions/rollout-ui.jsonl`, JSON.stringify({
      type: "event_msg", payload: { rate_limits: {
        primary: { used_percent: used, window_minutes: 300, resets_at: now + 7200 },
        secondary: { used_percent: used, window_minutes: 10080, resets_at: now + 3 * 86400 },
      } },
    }) + "\n");
  }
  const integration = "# Sandbox UI fixture: planner integration present\n";
  write("accounts/team/AGENTS.md", integration);
  json("install-manifest.json", { version: 1, planners: { "codex#team": {
    planner: "codex#team", account: "team", installedAt: now, pacerArgv: [], commands: [], notes: [],
    files: [{ path: join(home, "accounts/team/AGENTS.md"), action: "created", undo: [], afterHash: createHash("sha256").update(integration).digest("hex") }],
  } } });
  write("onboarding/skipped", "UI fixture\n");
  // Setup derives service readiness from a service file plus a manager status.
  // These sandbox-only stubs answer that read, and refuse every manager mutation.
  write("Library/LaunchAgents/com.pacer.serve.plist", "<!-- Managed by pacer service: UI fixture only -->\n");
  write(".config/systemd/user/pacer-serve.service", "# Managed by pacer service: UI fixture only\n");
  const refused = "echo 'Live validation D3: UI fixture refuses execution' >&2\nexit 3\n";
  write("bin/launchctl", '#!/bin/sh\nif [ "$#" = 2 ] && [ "$1" = print ]; then\n  printf "pid = 1\\nlast exit code = 0\\n"\n  exit 0\nfi\n' + refused, 0o700);
  write("bin/systemctl", '#!/bin/sh\nif [ "$#" = 4 ] && [ "$1" = --user ] && [ "$2" = show ] && [ "$3" = pacer-serve.service ] && [ "$4" = --property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus ]; then\n  printf "LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=1\\nExecMainStatus=0\\n"\n  exit 0\nfi\n' + refused, 0o700);
  for (const bin of ["codex", "claude", "cursor", "cursor-agent", "opencode", "arkcli", "orca"]) write(`bin/${bin}`, "#!/bin/sh\n" + refused, 0o700);

  const repo = join(home, "repos/sample");
  const repoKey = `local:${createHash("sha256").update(repo).digest("hex").slice(0, 12)}`;
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  json("state/repos.json", { [repo]: { key: repoKey, path: repo, lastUsed: now } });
  const states = ["done", "failed", "partial", "running", "done"] as const;
  const attention: Record<string, { since: number }> = {};
  const ctxAt = (at: number): Ctx => ({ home, pacerHome: home, now: at, env: {},
    run: async () => { throw Error("seed cannot run commands"); }, which: () => null });
  let runningId = "";
  states.forEach((state, index) => {
    const ctx = ctxAt(now - 300 + index);
    const { id } = createTask(ctx, { brief: { goal: "fixture", repo: join(home, "repos/sample") },
      kind: "feature", requestedExecutor: null, timeoutS: 3600 });
    const source = state === "running" ? session : snapshot.tasks.find((task: { state: string }) => task.state === state) ?? detail;
    const worktree = join(home, "worktrees", id);
    if (state !== "failed") mkdirSync(worktree, { recursive: true, mode: 0o700 });
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    const task: TaskRecord = {
      id, rev: 1, source: "ui", createdAt: now - 300 + index, state, kind: "feature", timeoutS: 3600,
      requestedExecutor: null, executor: "codex#personal", backend: "direct", worktree,
      repo: { key: repoKey, label: "sample", path: repo },
      brief: { goal: source.goal, repo, acceptance: detail.brief.acceptance, context: session.brief.data },
      attempts: [],
    };
    if (state === "running") {
      runningId = id;
      // PID 1 is a liveness sentinel, never a child: no run/childPid means no
      // recovery spawn or stop signal. No executor exists behind this fixture.
      task.runnerPid = 1;
      task.progress = { phase: "working", lastOutputAt: now, lastChangeAt: now, host: "local", updatedAt: now, files: 6, commits: 2, logBytes: 0 };
    } else {
      const log = join(home, "logs", `${id}.log`);
      write(`logs/${id}.log`, state === "failed" ? "Fixture failure: worktree removed\n" : session.log.data + "\n");
      task.attempts = [{ executor: "codex#personal", model: null, startedAt: now - 600, endedAt: now - 60, exitCode: state === "failed" ? 1 : 0, timedOut: false, limitHit: false, log }];
      task.result = { status: state, executor: "codex#personal", model: null, backend: "direct", worktree,
        files: state === "failed" ? "" : "src/example.ts | 4 ++--", report: state === "failed" ? "Fixture failure; the worktree has been removed." : detail.summary,
        acceptance: { cmd: "bun test", passed: state === "done", tail: state === "done" ? "38 passed" : "Fixture checks incomplete" } };
      if (index === 0) task.reviewRequest = {note:"Please review the permission change before integrating.",at:now-60};
      if (index === 4) task.review = { accepted: true, kind: "feature", note: "Sample accepted work", at: now - 30 };
      else attention[`${state === "failed" ? "failed" : "review"}:${id}`] = { since: now - 60 };
    }
    updateTask(ctx, id, record => { Object.assign(record, task); });
  });
  seedWorkTree(ctxAt(now), runningId, repo, repoKey);
  json("state/attention.json", attention);
}

/**
 * The running task becomes a work-tree root with one settled subtask that has measured tokens and one still
 * running, so the tree shows a live token total without an executor. Children reuse the PID 1 sentinel.
 */
function seedWorkTree(ctx: Ctx, rootId: string, repo: string, repoKey: string): void {
  const now = ctx.now;
  registerWork(ctx, rootId, { allowDelegation: true });
  const tokens: AttemptTokens = { coverage: "measured", input: 9_120, cacheRead: 2_048, cacheWrite: null, output: 795, reasoning: 312,
    total: 11_963, turns: 6, source: "executor-text", selfReported: false, extractor: "codex-text@1", capturedAt: now - 90 };
  for (const [title, state] of [["Add the usage parser", "done"], ["Wire the parser into the report", "running"]] as const) {
    const { id } = createTask(ctx, { brief: { goal: title, repo }, kind: "feature", requestedExecutor: null, timeoutS: 3600 });
    updateTask(ctx, id, record => {
      Object.assign(record, { title, state: "running", executor: "codex#personal", backend: "direct", repo: { key: repoKey, label: "sample", path: repo }, runnerPid: 1 });
      record.progress = { phase: "working", lastOutputAt: now, lastChangeAt: now, host: "local", updatedAt: now, files: 1, commits: 0, logBytes: 0 };
    });
    registerWork(ctx, id, {}, rootId);
    if (state === "running") continue;
    mkdirSync(join(ctx.pacerHome, "logs"), { recursive: true, mode: 0o700 });
    atomicWrite(join(ctx.pacerHome, "logs", `${id}.log`), "Parser added.\n", 0o600);
    updateTask(ctx, id, record => {
      record.attempts = [{ executor: "codex#personal", model: null, startedAt: now - 400, endedAt: now - 90, exitCode: 0, timedOut: false, limitHit: false, log: join(ctx.pacerHome, "logs", `${id}.log`), tokens }];
      recordAttemptUsage(ctx, record, 1, tokens, "personal");
      delete record.runnerPid; delete record.progress;
      record.state = "done"; record.settledAt = now - 90;
      record.result = { status: "done", executor: "codex#personal", model: null, backend: "direct", files: "src/usage.ts | 12 ++++", report: "Parser added.", acceptance: { cmd: "bun test", passed: true, tail: "4 passed" } };
      record.review = { accepted: true, kind: "feature", note: "Accepted by the parent task", at: now - 60 };
    });
  }
}
