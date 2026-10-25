import { probeAgentSession } from "./agent-probe";
import { executorEnv } from "../exec/process";
import { providerEnv } from "../exec/launch";
import { route } from "../core/routing";
import { resolvePolicyRepoInput } from "../core/project-policy";
import { loadStrategy } from "../config/strategy";
import { parseRunnerId, resolveRunner } from "../config/runner-id";
import { agentSessionCapabilities } from "../plugins/agent-session";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { RepoRef } from "../api/read-model/types";
import type { AgentSessionCapabilities } from "@pacer/plugin";

export interface SessionExecutor {
  id: string;
  agent: string;
  account: string;
  version: string;
  available: boolean;
  capabilities: AgentSessionCapabilities;
  reason?: string;
}
export interface SessionPreparation {
  repo: RepoRef;
  branches: string[];
  base: string;
  checkouts: { path: string; branch: string; dirty: boolean }[];
  executors: SessionExecutor[];
}
export async function prepareSession(
  ctx: Ctx,
  input: { repo: string; executor?: string },
): Promise<SessionPreparation> {
  const repo = await resolvePolicyRepoInput(ctx, input.repo),
    strategy = loadStrategy(ctx);
  const routing = await route(ctx, null, strategy, { repo: repo.key, conversation: true });
  const executors: SessionExecutor[] = [];
  for (const cfg of Object.values(strategy.providers)) {
    const runner = resolveRunner(strategy, cfg.id),
      agent =
        cfg.via === "opencode"
          ? "opencode"
          : (parseRunnerId(cfg.id)?.agent ?? cfg.id);
    const remote = !!runner?.host;
    let probe: Awaited<ReturnType<typeof probeAgentSession>> = {agent, version: "unknown"};
    if (!remote) {
      try {
        const env = executorEnv(ctx.env, await providerEnv(ctx, cfg, {probe: true}));
        probe = await probeAgentSession(ctx, agent, env);
      } catch {
        probe.reason = `The account environment for ${cfg.id} is unavailable. Check its account configuration.`;
      }
    }
    const version = probe.version;
    const capabilities = probe.reason
      ? {interactive: false, resume: false, launchImages: false, liveImages: false, files: false, reason: probe.reason}
      : await agentSessionCapabilities(ctx, probe);
    const ranked = routing.ranked.some((r) => r.id === cfg.id);
    const reason = remote
      ? "Interactive remote sessions are not supported."
      : !capabilities.interactive
        ? capabilities.reason
        : !ranked
          ? (routing.excluded.find((r) => r.id === cfg.id)?.reason ?? "Executor is not eligible.")
          : undefined;
    executors.push({
      id: cfg.id,
      agent,
      account: runner?.account ?? "default",
      version,
      capabilities,
      available: !reason,
      ...(reason ? { reason } : {}),
    });
  }
  const branchesResult = await ctx.run(
    [
      "git",
      "-C",
      repo.path,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes/origin",
    ],
    5000,
  );
  if (branchesResult.code)
    throw new CoreError("invalid_input", "Repository branches are unavailable");
  const branches = branchesResult.stdout.trim().split("\n").filter(Boolean);
  const defaultRef = await ctx.run(
    [
      "git",
      "-C",
      repo.path,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ],
    5000,
  );
  const current = await ctx.run(
    ["git", "-C", repo.path, "symbolic-ref", "--short", "HEAD"],
    5000,
  );
  const base =
    defaultRef.code === 0
      ? defaultRef.stdout.trim()
      : current.stdout.trim() || "HEAD";
  const trees = await ctx.run(
    ["git", "-C", repo.path, "worktree", "list", "--porcelain", "-z"],
    5000,
  );
  const checkouts: SessionPreparation["checkouts"] = [];
  let checkout: { path: string; branch: string } | undefined;
  for (const field of trees.stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      checkout = { path: field.slice(9), branch: "Detached HEAD" };
      checkouts.push({ ...checkout, dirty: false });
    }
    if (field.startsWith("branch ") && checkouts.length)
      checkouts.at(-1)!.branch = field.slice(7).replace(/^refs\/heads\//, "");
  }
  for (const tree of checkouts) {
    const status = await ctx.run(
      ["git", "-C", tree.path, "status", "--porcelain"],
      5000,
    );
    tree.dirty = status.code !== 0 || !!status.stdout.trim();
  }
  return { repo, branches, base, checkouts, executors };
}
