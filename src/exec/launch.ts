import { parseRunnerId, resolveRunner } from "../config/runner-id";
import { join } from "node:path";
import { loadStrategy, MissingStrategyError, type ProviderCfg } from "../config/strategy";
import type { RunnerCfg } from "../config/accounts";
import type { Ctx } from "../types";
import { orcaAccountHome } from "../orca/accounts";

/** Select only an account's config directory; never inspect credentials. */
export function runnerEnv(ctx: Ctx, runner: RunnerCfg): Record<string, string> {
  const account = loadStrategy(ctx).accounts[runner.account];
  if (!account) throw new Error(`account not configured: ${runner.account}`);
  if (account.source === "default" || account.source === "endpoint") return {};
  if (account.kind !== "claude" && account.kind !== "codex") return {};
  const home = account.source === "orca" ? orcaAccountHome(ctx, account.kind, account.orcaAccount ?? "") : account.home?.replace(/^~(?=\/|$)/, ctx.home);
  if (!home) throw new Error(`account folder not found: ${runner.account}`);
  return {[account.kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: home};
}

/** Bridge backends still accepting the compatibility provider view. */
export function providerEnv(ctx: Ctx, cfg: ProviderCfg): Record<string, string> {
  let strategy;
  try { strategy = loadStrategy(ctx); } catch (e) {
    if (e instanceof MissingStrategyError && (cfg.via === "opencode" || !parseRunnerId(cfg.id)?.account)) return {};
    throw e;
  }
  const runner = resolveRunner(strategy, cfg.id);
  if (!runner) throw new Error(`runner not configured: ${cfg.id}`);
  return runnerEnv(ctx, runner);
}

export interface Launch { argv: string[]; cwd: string; stdin?: string; lastMessageFile?: string }

export function launchFor(cfg: ProviderCfg, prompt: string, repo: string, taskDir: string, taskId: string): Launch {
  const model = cfg.model;
  if (cfg.via === "opencode") {
    return {
      cwd: repo,
      argv: ["opencode", "run", "--agent", "build", "-m", model ?? "", "--auto", "--title", `pacer ${taskId}`, prompt],
    };
  }
  switch (parseRunnerId(cfg.id)?.agent ?? cfg.id) {
    case "codex": {
      const lastMessageFile = join(taskDir, `${taskId}.codex-last.md`);
      return {
        cwd: repo,
        stdin: prompt,
        lastMessageFile,
        argv: ["codex", "exec", "-C", repo, "-s", "workspace-write", "--skip-git-repo-check", "-o", lastMessageFile,
          ...(model ? ["-m", model] : []), "-"],
      };
    }
    case "cursor":
      return {
        cwd: repo,
        argv: ["cursor-agent", "-p", "--output-format", "text", "--force", "--workspace", repo, ...(model ? ["--model", model] : []), prompt],
      };
    case "agy":
      return {
        cwd: repo,
        argv: ["agy", "--sandbox", "--dangerously-skip-permissions", "--add-dir", repo, ...(model ? ["--model", model] : []), "-p", prompt],
      };
    case "claude-code":
      return {
        cwd: repo,
        argv: ["claude", "-p", "--permission-mode", "acceptEdits", "--output-format", "text", ...(model ? ["--model", model] : []), prompt],
      };
    default:
      throw new Error(`no launcher for provider "${cfg.id}"`);
  }
}
