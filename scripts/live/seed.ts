import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTask, updateTask } from "../../src/tasks/store";
import type { Ctx } from "../../src/types";
import type { TaskRecord } from "../../src/tasks/types";
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
    planner: "codex", account: "team", installedAt: now, pacerArgv: [], commands: [], notes: [],
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

  const states = ["done", "failed", "partial", "running", "done"] as const;
  const attention: Record<string, { since: number }> = {};
  states.forEach((state, index) => {
    const ctx: Ctx = { home, pacerHome: home, now: now - 300 + index, env: {},
      run: async () => { throw Error("seed cannot run commands"); }, which: () => null };
    const { id } = createTask(ctx, { brief: { goal: "fixture", repo: join(home, "repos/sample") },
      kind: "feature", requestedExecutor: null, timeoutS: 0 });
    const source = state === "running" ? session : snapshot.tasks.find((task: { state: string }) => task.state === state) ?? detail;
    const repo = join(home, "repos/sample");
    const worktree = join(home, "worktrees", id);
    if (state !== "failed") mkdirSync(worktree, { recursive: true, mode: 0o700 });
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    const task: TaskRecord = {
      id, rev: 1, source: "ui", createdAt: now - 300 + index, state, kind: "feature", timeoutS: 0,
      requestedExecutor: null, executor: "codex#personal", backend: "direct", worktree,
      repo: { key: `local:${repo}`, label: "sample", path: repo },
      brief: { goal: source.goal, repo, acceptance: detail.brief.acceptance, context: session.brief.data },
      attempts: [],
    };
    if (state === "running") {
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
      if (index === 4) task.review = { accepted: true, kind: "feature", note: "Sample accepted work", at: now - 30 };
      else attention[`${state === "failed" ? "failed" : "review"}:${id}`] = { since: now - 60 };
    }
    updateTask(ctx, id, record => { Object.assign(record, task); });
  });
  json("state/attention.json", attention);
}
