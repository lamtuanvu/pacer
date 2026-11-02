// Actual configured-host issuer oracle; invoked only with a disposable test home.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueConfiguredHostStop } from "../../src/plugins/host-stop-issuer";
import { createTask, updateTask } from "../../src/tasks/store";
import { fakeCtx } from "../helpers";

const home = join(process.env.PACER_HOME!, "stop-budget-oracle");
mkdirSync(home, { recursive: true, mode: 0o700 });
writeFileSync(join(home, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n", { mode: 0o600 });
const ctx = fakeCtx({ home, pacerHome: home });
const task = createTask(ctx, { brief: { goal: "stop budget", repo: home }, kind: null, requestedExecutor: null, timeoutS: 60 });
const local = join(home, "runs", task.id, "1"), remote = `/remote/.pacer-remote/runs/${task.id}/1`;
updateTask(ctx, task.id, record => {
  record.state = "running";
  record.run = { host: "box", mode: "new", remoteDir: remote, remoteWorktree: "/remote/worktree",
    workdir: "/remote/worktree", dir: local, attempt: 1, executor: "codex@box", startedAt: 1, logFile: "unused" };
});
const cases: number[] = JSON.parse(process.argv.at(-1)!);
console.log(JSON.stringify(cases.map(graceMs => {
  try {
    const resource = issueConfiguredHostStop(ctx, "box", remote, local, Math.ceil(graceMs / 1000)).resource;
    return { seconds: Number(resource.args[1]), timeoutMs: resource.timeoutMs };
  } catch (error) { return { error: (error as {code:string}).code }; }
})));
