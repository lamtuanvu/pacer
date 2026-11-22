// Gated run.publish: push the run branch and open a PR (Phase 5).
// Gate: a publish_approved decision newer than the branch tip, or draft opt-in with draft:true.
// External side effects (push, gh) are argv/stdin only, never force-push, and recoverable after a crash.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import {
  getRun, listDecisions, setRunPrUrl, type RunRow,
} from "./store";
import {
  integrationWorktreeUnderLock, withMergeLock,
} from "./branch";

const TITLE_MAX = 256;
const BODY_MAX = 60 * 1024;
const STDERR_CAP = 4 * 1024;

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const cap = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n));

export type PublishInput = {
  draft: boolean;
  title: string;
  body: string;
  expectRev: number;
};

export type PublishResult = { pr_url: string; run: RunRow };

function validatePublishInput(input: PublishInput): void {
  if (typeof input.title !== "string" || input.title.length < 1 || input.title.length > TITLE_MAX) {
    throw new CoreError("invalid_input", `title must be 1..${TITLE_MAX} characters`);
  }
  if (typeof input.body !== "string" || Buffer.byteLength(input.body, "utf8") > BODY_MAX) {
    throw new CoreError("invalid_input", `body must be at most ${BODY_MAX} bytes`);
  }
  if (typeof input.draft !== "boolean") {
    throw new CoreError("invalid_input", "draft must be a boolean");
  }
  if (!Number.isInteger(input.expectRev)) {
    throw new CoreError("invalid_input", "expect_rev must be an integer");
  }
}

/** True when the run still has a durable unresolved conflict marker (I1). */
export function hasUnresolvedConflictTask(ctx: Ctx, runId: string): boolean {
  return !!getRun(ctx, runId)?.conflict;
}

async function branchTipCommitTime(ctx: Ctx, repo: string, branch: string): Promise<number> {
  const tip = await ctx.run(["git", "-C", repo, "log", "-1", "--format=%ct", branch], 10_000);
  const n = Number(tip.stdout.trim());
  if (tip.code !== 0 || !Number.isFinite(n)) {
    throw new CoreError("unavailable", `cannot read branch tip time: ${firstLine(tip.stderr)}`);
  }
  return n;
}

/** Gate check (D5): draft opt-in, or a publish_approved decision newer than the branch tip. */
export async function assertPublishGate(ctx: Ctx, run: RunRow, draft: boolean): Promise<void> {
  if (!run.branch) throw new CoreError("invalid_input", `run ${run.id} has no branch to publish`);
  if (hasUnresolvedConflictTask(ctx, run.id)) {
    throw new CoreError("not_allowed", "run has an unresolved conflict task");
  }
  if (run.publishOptIn === "draft" && draft === true) return;

  const approvals = listDecisions(ctx, run.id).filter(d => d.kind === "publish_approved");
  const latest = approvals[approvals.length - 1];
  if (!latest) {
    throw new CoreError("not_allowed", "publishing requires a must approval or draft opt-in");
  }
  const tipCt = await branchTipCommitTime(ctx, run.repo, run.branch);
  if (!(latest.at > tipCt)) {
    throw new CoreError("not_allowed", "publish approval is older than the run branch's last change");
  }
}

function assertHttpsPrUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed)) {
    throw new CoreError("unavailable", "gh returned a non-https PR URL");
  }
  return trimmed;
}

async function existingPrUrl(ctx: Ctx, wt: string, branch: string, env: Record<string, string | undefined>): Promise<string | null> {
  const listed = await ctx.run(
    ["gh", "pr", "list", "--head", branch, "--json", "url", "--limit", "1"],
    30_000,
    { env, stdin: "", cwd: wt },
  );
  if (listed.code !== 0) return null;
  const text = listed.stdout.trim();
  if (!text || text === "[]") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed) && parsed[0] && typeof (parsed[0] as { url?: unknown }).url === "string") {
      return assertHttpsPrUrl((parsed[0] as { url: string }).url);
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    // Non-JSON stub output: a bare URL from our recovery path.
  }
  const candidate = text.split(/\s+/)[0] ?? "";
  if (/^https:\/\//i.test(candidate)) return assertHttpsPrUrl(candidate);
  return null;
}

/**
 * Push the run branch to origin and open a PR. Library form of `run.publish`
 * (ops/CLI arrive in a later batch). Never force-pushes. Idempotent when `pr_url`
 * is already stored, and recoverable when push or `gh` already succeeded.
 */
export async function publishRun(ctx: Ctx, runId: string, input: PublishInput): Promise<PublishResult> {
  validatePublishInput(input);
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (run.rev !== input.expectRev) {
    throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${input.expectRev}`);
  }
  if (run.prUrl) return { pr_url: run.prUrl, run };

  await assertPublishGate(ctx, run, input.draft);

  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, runId) ?? run;
    if (live.rev !== input.expectRev) {
      throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${input.expectRev}`);
    }
    if (live.prUrl) return { pr_url: live.prUrl, run: live };
    await assertPublishGate(ctx, live, input.draft);
    if (!live.branch || !live.baseRef) {
      throw new CoreError("invalid_input", `run ${runId} has no branch to publish`);
    }

    const wt = await integrationWorktreeUnderLock(ctx, live);
    const pathEnv = { ...ctx.env, PATH: ctx.env.PATH ?? process.env.PATH };

    const pushed = await ctx.run(
      ["git", "-C", wt, "push", "origin", live.branch],
      120_000,
      { env: pathEnv },
    );
    if (pushed.code !== 0) {
      throw new CoreError("unavailable", cap(firstLine(pushed.stderr) || firstLine(pushed.stdout) || `git push exit ${pushed.code}`, STDERR_CAP));
    }

    let prUrl = await existingPrUrl(ctx, wt, live.branch, pathEnv);
    if (!prUrl) {
      const argv = [
        "gh", "pr", "create",
        "--head", live.branch,
        "--base", live.baseRef,
        "--title", input.title,
        "--body-file", "-",
        ...(input.draft ? ["--draft"] as const : []),
      ];
      const created = await ctx.run(argv, 120_000, { env: pathEnv, stdin: input.body, cwd: wt });
      if (created.code !== 0) {
        // Crash recovery: push may have left a PR from a prior attempt.
        prUrl = await existingPrUrl(ctx, wt, live.branch, pathEnv);
        if (!prUrl) {
          throw new CoreError("unavailable", cap(firstLine(created.stderr) || firstLine(created.stdout) || `gh pr create exit ${created.code}`, STDERR_CAP));
        }
      } else {
        const token = created.stdout.trim().split(/\s+/).find(s => /:\/\//.test(s));
        if (token) {
          prUrl = assertHttpsPrUrl(token);
        } else {
          prUrl = await existingPrUrl(ctx, wt, live.branch, pathEnv);
        }
        if (!prUrl) {
          throw new CoreError("unavailable", "gh pr create succeeded without a PR URL");
        }
      }
    }
    prUrl = assertHttpsPrUrl(prUrl);

    setRunPrUrl(ctx, live.id, prUrl);
    const updated = getRun(ctx, live.id) ?? { ...live, prUrl };
    return { pr_url: prUrl, run: updated };
  });
}
