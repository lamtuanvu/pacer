// Gated run.publish: push the run branch and open a PR (Phase 5).
// Gate: a publish_approved decision newer than the branch tip, or draft opt-in with draft:true.
// External side effects (push, gh) are argv/stdin only, never force-push, and recoverable after a crash.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { ghEnv } from "../core/issue-import";
import {
  branchOwner, getRun, listDecisions, setRunPrUrl, type RunRow,
} from "./store";
import {
  adoptGeneratedBranches, integrationWorktreeUnderLock, withMergeLock,
} from "./branch";

/** Extra names beyond ghEnv that publish children may need. */
const PUBLISH_EXTRA = new Set([
  "GH_ENTERPRISE_TOKEN", "GH_HOST", "SSH_AUTH_SOCK",
  "ALL_PROXY", "NODE_EXTRA_CA_CERTS",
  "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY",
  "LANG", "LC_ALL",
]);
const PUBLISH_EXTRA_PREFIXES = ["GCM_", "SSH_"];
const PUBLISH_EXTRA_SUFFIXES = ["_CA_BUNDLE"];
/** GIT_* that must not leak a caller's checkout into engine-owned git. */
const GIT_DROP = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]);

/**
 * Child env for git push / gh: allowlist only; never PACER_* (I10).
 * Engine-owned pushes still run repo pre-push hooks (GH_TOKEN / SSH_AUTH_SOCK
 * available); they do not pass --no-verify so hooks can refuse a bad push.
 */
export function publishChildEnv(ctx: Ctx): Record<string, string | undefined> {
  const fromGh = ghEnv(ctx.env);
  const out: Record<string, string | undefined> = { ...fromGh };
  for (const [name, value] of Object.entries(ctx.env)) {
    if (value === undefined) continue;
    if (name.startsWith("PACER_")) continue;
    if (GIT_DROP.has(name)) continue;
    if (name.startsWith("GIT_") || PUBLISH_EXTRA.has(name)
      || PUBLISH_EXTRA_PREFIXES.some(p => name.startsWith(p))
      || PUBLISH_EXTRA_SUFFIXES.some(s => name.endsWith(s))) {
      out[name] = value;
    }
  }
  out.PATH = ctx.env.PATH ?? process.env.PATH;
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

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
  if (typeof input.title !== "string" || input.title.trim().length < 1 || input.title.length > TITLE_MAX) {
    throw new CoreError("invalid_input", `title must be 1..${TITLE_MAX} characters`);
  }
  // Leading '-' is refused so titles cannot be mistaken for argv flags when passed to gh.
  if (input.title.startsWith("-")) {
    throw new CoreError("invalid_input", "title must not start with '-'");
  }
  if (/[\u0000-\u001f\u007f]/.test(input.title)) {
    throw new CoreError("invalid_input", "title must not contain control characters");
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

/** True when the run still has at least one durable unresolved conflict entry (I1/R2-F3). */
export function hasUnresolvedConflictTask(ctx: Ctx, runId: string): boolean {
  return (getRun(ctx, runId)?.conflict?.length ?? 0) > 0;
}

async function branchTipSha(ctx: Ctx, repo: string, branch: string): Promise<string> {
  // M9: qualify refs/heads/ so a tag of the same name cannot spoof the tip.
  const tip = await ctx.run(["git", "-C", repo, "rev-parse", "--verify", `refs/heads/${branch}`], 10_000);
  const sha = tip.stdout.trim();
  if (tip.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new CoreError("unavailable", `cannot read branch tip: ${firstLine(tip.stderr)}`);
  }
  return sha;
}

async function branchTipCommitTime(ctx: Ctx, repo: string, branch: string): Promise<number> {
  const tip = await ctx.run(["git", "-C", repo, "log", "-1", "--format=%ct", `refs/heads/${branch}`], 10_000);
  const n = Number(tip.stdout.trim());
  if (tip.code !== 0 || !Number.isFinite(n)) {
    throw new CoreError("unavailable", `cannot read branch tip time: ${firstLine(tip.stderr)}`);
  }
  return n;
}

/** Parse `tip=<sha>` from a publish_approved reason. */
export function approvedTipFromReason(reason: string): string | null {
  const m = /\btip=([0-9a-f]{40,64})\b/i.exec(reason);
  return m?.[1]?.toLowerCase() ?? null;
}

/** Gate check (D5): draft opt-in, or a person publish_approved for the current tip.
 *  A generated child is checked as the run that owns its branch. */
export async function assertPublishGate(ctx: Ctx, of: RunRow, draft: boolean): Promise<void> {
  const run = branchOwner(ctx, of);
  if (!run.branch) throw new CoreError("invalid_input", `run ${run.id} has no branch to publish`);
  if (hasUnresolvedConflictTask(ctx, run.id)) {
    throw new CoreError("not_allowed", "run has an unresolved conflict task");
  }
  if (run.publishOptIn === "draft" && draft === true) return;

  const approvals = listDecisions(ctx, run.id).filter(d => d.kind === "publish_approved" && d.actor === "person");
  const latest = approvals[approvals.length - 1];
  if (!latest) {
    throw new CoreError("not_allowed", "publishing requires a must approval or draft opt-in");
  }
  const tipSha = (await branchTipSha(ctx, run.repo, run.branch)).toLowerCase();
  const approvedTip = approvedTipFromReason(latest.reason);
  if (approvedTip) {
    if (approvedTip !== tipSha) {
      throw new CoreError("not_allowed", "publish approval is for a different run branch tip");
    }
    return;
  }
  // Legacy decisions without tip=: require floored approval time strictly after tip time.
  const tipCt = await branchTipCommitTime(ctx, run.repo, run.branch);
  if (!(Math.floor(latest.at) > tipCt)) {
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

/** Defensive: never push or open a PR for a branch that holds no work. A count
 *  git cannot make is left to the push. */
async function assertBranchHasCommits(ctx: Ctx, run: RunRow): Promise<void> {
  const count = await ctx.run(
    ["git", "-C", run.repo, "rev-list", "--count", `${run.baseSha ?? run.baseRef}..refs/heads/${run.branch}`],
    15_000,
  );
  if (count.code === 0 && count.stdout.trim() === "0") {
    throw new CoreError("not_allowed", "the run branch has no commits beyond its base: nothing to publish");
  }
}

/** Parse `owner/name` from an origin remote URL for `gh --repo` (M9). */
export async function originRepoSlug(ctx: Ctx, repoOrWt: string): Promise<string | null> {
  const got = await ctx.run(["git", "-C", repoOrWt, "remote", "get-url", "origin"], 10_000);
  if (got.code !== 0) return null;
  const url = got.stdout.trim();
  // Repo names may contain dots (owner/my.repo); only a trailing .git is stripped.
  const m = /(?:github\.com[:/]|git@[^:]+:)([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url)
    || /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

async function existingPrUrl(
  ctx: Ctx, wt: string, branch: string, env: Record<string, string | undefined>, ghBin: string, repoSlug: string | null,
): Promise<string | null> {
  const listed = await ctx.run(
    [
      ghBin, "pr", "list", "--head", branch, "--json", "url", "--limit", "1",
      ...(repoSlug ? ["--repo", repoSlug] as const : []),
    ],
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
  const asked = getRun(ctx, runId);
  if (!asked) throw new CoreError("not_found", `unknown run ${runId}`);
  if (asked.rev !== input.expectRev) {
    throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${input.expectRev}`);
  }
  await adoptGeneratedBranches(ctx, asked);
  // A generated child publishes its owner's branch, under the owner's gate.
  const run = branchOwner(ctx, asked);
  const rev = run.rev;
  if (run.prUrl) return { pr_url: run.prUrl, run };

  await assertPublishGate(ctx, run, input.draft);

  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, run.id) ?? run;
    if (live.rev !== rev) {
      throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${input.expectRev}`);
    }
    if (live.prUrl) return { pr_url: live.prUrl, run: live };
    await assertPublishGate(ctx, live, input.draft);
    if (!live.branch || !live.baseRef) {
      throw new CoreError("invalid_input", `run ${runId} has no branch to publish`);
    }
    await assertBranchHasCommits(ctx, live);

    const wt = await integrationWorktreeUnderLock(ctx, live);
    const pathEnv = publishChildEnv(ctx);
    const ghBin = ctx.which("gh");
    if (!ghBin) {
      throw new CoreError("unavailable", "gh is not installed");
    }
    const repoSlug = await originRepoSlug(ctx, wt);

    const pushed = await ctx.run(
      ["git", "-C", wt, "push", "origin", `refs/heads/${live.branch}:refs/heads/${live.branch}`],
      120_000,
      { env: pathEnv },
    );
    if (pushed.code !== 0) {
      throw new CoreError("unavailable", cap(firstLine(pushed.stderr) || firstLine(pushed.stdout) || `git push exit ${pushed.code}`, STDERR_CAP));
    }

    let prUrl = await existingPrUrl(ctx, wt, live.branch, pathEnv, ghBin, repoSlug);
    if (!prUrl) {
      const base = live.baseRef.startsWith("origin/") ? live.baseRef.slice("origin/".length) : live.baseRef;
      const argv = [
        ghBin, "pr", "create",
        "--head", live.branch,
        "--base", base,
        `--title=${input.title}`,
        "--body-file", "-",
        ...(repoSlug ? ["--repo", repoSlug] as const : []),
        ...(input.draft ? ["--draft"] as const : []),
      ];
      const created = await ctx.run(argv, 120_000, { env: pathEnv, stdin: input.body, cwd: wt });
      if (created.code !== 0) {
        // Crash recovery: push may have left a PR from a prior attempt.
        prUrl = await existingPrUrl(ctx, wt, live.branch, pathEnv, ghBin, repoSlug);
        if (!prUrl) {
          throw new CoreError("unavailable", cap(firstLine(created.stderr) || firstLine(created.stdout) || `gh pr create exit ${created.code}`, STDERR_CAP));
        }
      } else {
        const token = created.stdout.trim().split(/\s+/).find(s => /:\/\//.test(s));
        if (token) {
          prUrl = assertHttpsPrUrl(token);
        } else {
          prUrl = await existingPrUrl(ctx, wt, live.branch, pathEnv, ghBin, repoSlug);
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
