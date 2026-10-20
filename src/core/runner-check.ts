import { join } from "node:path";
import { resolveRunner } from "../config/runner-id";
import { loadStrategy } from "../config/strategy";
import { runTestTask } from "../endpoints/test-task";
import { redactEndpointError } from "../endpoints/state";
import { readJson, writeJsonAtomic } from "../fsutil";
import { detectAgents } from "../install/detection";
import { startJob, type Job } from "../jobs/registry";
import type { Ctx } from "../types";
import { accountSignIn } from "../usage/signin";
import { list as listAccounts } from "./accounts";
import { CoreError } from "./errors";
import { check as checkLimits, type LimitsRow } from "./limits";
import { withLock } from "./lock";

export interface RunnerCheck { at: number; passed: boolean; detail: string }
export interface RunnerCheckDeps {
  detectAgents?: typeof detectAgents;
  listAccounts?: (ctx: Ctx) => Promise<{name: string; signedIn: boolean | null}[]>;
  checkLimits?: typeof checkLimits;
  runTestTask?: typeof runTestTask;
}
const file = (ctx: Ctx) => join(ctx.pacerHome, "state", "runner-checks.json");
export function readRunnerCheck(ctx: Ctx, id: string): RunnerCheck | null {
  return readJson<Record<string, RunnerCheck>>(file(ctx))?.[id] ?? null;
}
function usageDetail(row: LimitsRow | undefined, usage: string): string {
  if (usage === "unmetered") return "unmetered";
  if (row?.usedPct == null) return "no limit reported";
  const window = row.window ?? "usage";
  return `${window[0].toUpperCase()}${window.slice(1)} window · ${row.usedPct}% used`;
}

export async function checkRunner(ctx: Ctx, id: string, deps: RunnerCheckDeps = {}): Promise<Job> {
  const strategy = loadStrategy(ctx), runner = resolveRunner(strategy, id);
  if (!runner) throw new CoreError("unknown_executor", `unknown runner ${id}`);
  const account = strategy.accounts[runner.account];
  return startJob(ctx, "runner.check", runner.id, ["CLI found", "Signed in", "Usage readable", "Test task"], async step => {
    let current = "CLI found";
    const perform = async (name: string, detail: string, run: () => Promise<void>) => {
      current = name; step.start(name, detail);
      await run(); step.pass(name, detail);
    };
    let detail = "Executor is ready";
    let passed = false;
    try {
      const names = {agy: "Antigravity", codex: "Codex", "claude-code": "Claude Code", cursor: "Cursor", opencode: "OpenCode"};
      await perform("CLI found", `${names[runner.agent]} on ${runner.host ?? "this Mac"}`, async () => {
        const found = (await (deps.detectAgents ?? detectAgents)(ctx, {host: runner.host ?? undefined})).find(a => a.agent === runner.agent);
        if (!found?.found) throw Error(found?.install_hint ?? "Agent CLI not found");
      });
      // Reactive and unmetered accounts have no usage reader to authenticate.
      const hasUsage = account.usage === "quota" || account.usage === "metered";
      // Sign-in is the shared local login state (login indicator plus recorded
      // authentication failures), never a usage reading. A remote runner's login
      // lives on its host, where the test task exercises it.
      const local = runner.host === null;
      await perform("Signed in", local ? `Account ${account.name}` : `Account ${account.name} · checked by the test task on ${runner.host}`, async () => {
        if (!local) return;
        const status = (await (deps.listAccounts ?? listAccounts)(ctx)).find(a => a.name === account.name);
        if (!status) throw Error(`Sign in to account ${account.name}`);
        if (status.signedIn === false) {
          const signIn = accountSignIn(ctx, account);
          throw Error(`Sign in to account ${account.name}${signIn.reason ? ` (${signIn.reason})` : ""}`);
        }
      });
      const row = (await (deps.checkLimits ?? checkLimits)(ctx, strategy)).find(r => r.account === account.name);
      // Native usage first appears after the agent runs with this account (the Claude
      // Code status line or Codex session logs). Routing treats it as unknown, so a
      // missing first reading is skipped with its hint instead of failing the check.
      const native = account.kind === "claude" || account.kind === "codex";
      if (native && row && row.capturedAt === null && row.usedPct === null) {
        step.start("Usage readable");
        step.skip("Usage readable", `No usage reading yet${row.error ? ` · ${row.error}` : ""}${row.hint ? ` · ${row.hint}` : ""}`);
      } else {
        await perform("Usage readable", usageDetail(row, account.usage), async () => {
          if (row?.error) throw Error(row.error);
          if (hasUsage && !row) throw Error("Usage reading unavailable");
        });
      }
      await perform("Test task", "Write and run a one-line test in a scratch worktree", () => (deps.runTestTask ?? runTestTask)(ctx, runner.id));
      passed = true;
    } catch (error) {
      detail = redactEndpointError(error instanceof Error ? error.message : String(error), Object.entries(ctx.env).filter(([key]) => /key|token|secret|password/i.test(key)).map(([,value]) => value ?? ""));
      step.fail(current, detail);
      throw new Error(detail);
    } finally {
      await withLock(ctx, "runner-checks", async () => {
        const results = readJson<Record<string, RunnerCheck>>(file(ctx)) ?? {};
        results[runner.id] = {at: ctx.now, passed, detail};
        writeJsonAtomic(file(ctx), results);
      });
    }
  });
}
