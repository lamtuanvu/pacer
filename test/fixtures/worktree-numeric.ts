import { rmSync } from "node:fs";
import { answerCapability } from "../../src/plugins/host";
import { createCallAuthority } from "../../src/plugins/authority";
import { issueOwnedWorktreeGrant } from "../../src/plugins/executor-worktree";
import { manifestSchema } from "../../src/plugins/protocol";
import { createTask, updateTask } from "../../src/tasks/store";
import { fakeCtx, gitRepo, realRun, tmpDir } from "../helpers";

const cases: { method: string; spelling: string }[] = JSON.parse(Bun.argv.at(-1)!);
const results: string[] = [];
for (const { method, spelling } of cases) {
  const attempt = JSON.parse(spelling) as number;
  const issuedAttempt = Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 100 ? attempt : 1;
  const repo = gitRepo(), home = tmpDir(), ctx = fakeCtx({ run: realRun, home });
  try {
    const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null, requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, task.id, current => {
      current.state = "running"; current.executor = "codex"; current.executorProvider = "pacer-exec-direct";
      current.attempts = Array.from({ length: issuedAttempt - 1 }, () => ({ executor: "codex", model: null,
        startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" }));
    });
    const grant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", issuedAttempt, "HEAD");
    const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: ">=1.9.0",
      contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
    const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: grant },
      { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
    try {
      const params = { taskId: task.id, attempt, ...(method.endsWith("createOrReuse") ? { baseSha: grant.baseSha } : {}) };
      try { await answerCapability(ctx, { id: manifest.id, manifest }, method, params, authority); results.push("ok"); }
      catch (error) { results.push((error as { code?: string }).code ?? "unexpected"); }
    } finally { await authority.revoke(); }
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}
console.log(JSON.stringify(results));
