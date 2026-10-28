import { mkdirSync, writeFileSync } from "node:fs";
import { parseRunnerId, resolveRunner } from "../config/runner-id";
import { join } from "node:path";
import { loadStrategy, MissingStrategyError, type ProviderCfg } from "../config/strategy";
import type { RunnerCfg } from "../config/accounts";
import type { Ctx } from "../types";
import { readKey } from "../endpoints/keys";
import { endpointKeyEnv, writeOpencodeConfig } from "../endpoints/opencode-config";
import { orcaAccountHome } from "../orca/accounts";
import { ensureManagedClaudeStatusLine } from "../install/claude-managed-telemetry";

/** Resolve account settings and read endpoint credentials only when launching a child. */
export async function runnerEnv(ctx: Ctx, runner: RunnerCfg, probe = false): Promise<Record<string, string>> {
  const account = loadStrategy(ctx).accounts[runner.account];
  if (!account) throw new Error(`account not configured: ${runner.account}`);
  if (account.kind === "claude" && !probe) {
    try { ensureManagedClaudeStatusLine(ctx, account); }
    catch { /* A status-line setup failure must not prevent the executor launch. */ }
  }
  // Full OpenCode TUI no longer accepts --agent/-m; config works for both CLI generations.
  let opencodeEnv: Record<string, string> = {};
  if (runner.agent === "opencode") {
    let inline: unknown;
    try { inline = JSON.parse(ctx.env.OPENCODE_CONFIG_CONTENT ?? "{}"); }
    catch { throw Error("Invalid OPENCODE_CONFIG_CONTENT: expected a JSON object"); }
    if (!inline || typeof inline !== "object" || Array.isArray(inline)) {
      throw Error("Invalid OPENCODE_CONFIG_CONTENT: expected a JSON object");
    }
    opencodeEnv = {OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inline, default_agent: "build", ...(runner.model ? {model: runner.model} : {}),
    })};
  }
  if (account.connection) {
    if (probe) return opencodeEnv;
    const key = await readKey(ctx, account.name, account.connection.key);
    if (account.connection.key !== "none" && !key) throw Error(`Key missing for endpoint ${account.name}`);
    return {...opencodeEnv, OPENCODE_CONFIG: writeOpencodeConfig(ctx), ...(key ? {[endpointKeyEnv(account.name)]: key} : {})};
  }
  if (account.source === "default" || account.source === "endpoint" || account.source === "opencode") return opencodeEnv;
  if (account.kind !== "claude" && account.kind !== "codex") return {};
  const home = account.source === "orca" ? orcaAccountHome(ctx, account.kind, account.orcaAccount ?? "") : account.home?.replace(/^~(?=\/|$)/, ctx.home);
  if (!home) throw new Error(`account folder not found: ${runner.account}`);
  return {[account.kind === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: home};
}

/** Bridge backends still accepting the compatibility provider view. */
export async function providerEnv(ctx: Ctx, cfg: ProviderCfg, options: {probe?: boolean} = {}): Promise<Record<string, string>> {
  let strategy;
  try { strategy = loadStrategy(ctx); } catch (e) {
    if (e instanceof MissingStrategyError && (cfg.via === "opencode" || !parseRunnerId(cfg.id)?.account)) return {};
    throw e;
  }
  const runner = resolveRunner(strategy, cfg.id);
  if (!runner) throw new Error(`runner not configured: ${cfg.id}`);
  return runnerEnv(ctx, runner, options.probe);
}

/** CLI dotted overrides split on every dot, including quoted paths; use a TOML table value. */
function codexTrust(repo: string, root: string): string {
  return `projects={${[...new Set([repo, root])].map(path => `${JSON.stringify(path)}={trust_level="trusted"}`).join(",")}}`;
}

export interface Launch { argv: string[]; cwd: string; stdin?: string; lastMessageFile?: string }

/** An idle agent for Orca to attach to; Orca injects the task prompt after startup. */
export function launchArgvFor(cfg: ProviderCfg, worktree: string, runDir: string, trustRoot = worktree): string[] {
  const agent = parseRunnerId(cfg.id)?.agent ?? cfg.id;
  const models = cfg.model ? [agent === "codex" ? "-m" : "--model", cfg.model] : [];
  if (agent === "codex") return ["codex", "--no-daemon", "-c", codexTrust(worktree, trustRoot), "-C", worktree,
    "--dangerously-bypass-approvals-and-sandbox", "--add-dir", runDir, ...models];
  if (agent === "claude-code") return ["claude", "--dangerously-skip-permissions", ...models];
  throw Error(`no Orca terminal launcher for provider "${cfg.id}"`);
}

export function launchFor(cfg: ProviderCfg, prompt: string, repo: string, taskDir: string, taskId: string, sessionId?: string, trustRoot = repo): Launch {
  const model = cfg.model;
  if (cfg.session === "interactive") {
    if (Buffer.byteLength(prompt, "utf8") > 32 * 1024) {
      mkdirSync(taskDir, {recursive: true, mode: 0o700});
      const promptFile = join(taskDir, "prompt.md");
      writeFileSync(promptFile, prompt, {mode: 0o600});
      prompt = `Read the complete task instructions in ${JSON.stringify(promptFile)} and carry them out.`;
    }
    const agent = parseRunnerId(cfg.id)?.agent ?? cfg.id;
    const models = model ? [agent === "codex" || agent === "opencode" ? "-m" : "--model", model] : [];
    const argv = cfg.via === "opencode" ? ["opencode", "--standalone", "--auto", "--prompt", prompt]
      : agent === "codex" || agent === "claude-code" ? [...launchArgvFor(cfg, repo, taskDir, trustRoot), "--", prompt]
      : agent === "cursor" ? ["cursor-agent", "--force", "--sandbox", "disabled", "--workspace", repo, ...models, "--", prompt]
      : agent === "agy" ? ["agy", "--dangerously-skip-permissions", "--add-dir", repo, ...models, "--prompt-interactive", prompt] : null;
    if (!argv) throw new Error(`no interactive launcher for provider "${cfg.id}"`);
    return {cwd: repo, argv};
  }
  if (cfg.via === "opencode") {
    return {
      cwd: repo,
      // --standalone: a private server inherits this process's env (OPENCODE_CONFIG,
      // endpoint keys); the shared background service would ignore both.
      argv: ["opencode", "run", "--standalone", "--agent", "build", "-m", model ?? "", "--auto", "--title", `pacer ${taskId}`, prompt],
    };
  }
  switch (parseRunnerId(cfg.id)?.agent ?? cfg.id) {
    case "codex": {
      const lastMessageFile = join(taskDir, `${taskId}.codex-last.md`);
      return {
        cwd: repo,
        stdin: prompt,
        lastMessageFile,
        argv: ["codex", "exec", "-C", repo, "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-o", lastMessageFile,
          ...(model ? ["-m", model] : []), "-"],
      };
    }
    case "cursor":
      return {
        cwd: repo,
        argv: ["cursor-agent", "-p", "--output-format", "text", "--force", "--sandbox", "disabled", "--workspace", repo, ...(sessionId ? ["--resume", sessionId] : []), ...(model ? ["--model", model] : []), prompt],
      };
    case "agy":
      return {
        cwd: repo,
        argv: ["agy", "--dangerously-skip-permissions", "--add-dir", repo, ...(model ? ["--model", model] : []), "-p", prompt],
      };
    case "claude-code":
      return {
        cwd: repo,
        argv: ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", ...(sessionId ? ["--session-id", sessionId] : []), ...(model ? ["--model", model] : []), prompt],
      };
    default:
      throw new Error(`no launcher for provider "${cfg.id}"`);
  }
}

/** Remote prompts always use stdin; output files belong to the host run directory. */
export function remoteLaunch(cfg: ProviderCfg, workdir: string, runDir = workdir): Pick<Launch, "argv" | "lastMessageFile"> {
  const agent = parseRunnerId(cfg.id)?.agent;
  if (agent !== "codex" && agent !== "claude-code") throw new Error("remote runners support codex and claude-code");
  const launch = launchFor(cfg, "", workdir, runDir, "remote");
  if (agent === "claude-code") {
    launch.argv[launch.argv.indexOf("--output-format") + 1] = "text";
    launch.argv.splice(launch.argv.indexOf("--verbose"), 1);
    return { argv: launch.argv.slice(0, -1) };
  }
  const lastMessageFile = join(runDir, "last.md");
  launch.argv[launch.argv.indexOf("-o") + 1] = lastMessageFile;
  return { argv: launch.argv, lastMessageFile };
}

/** Resume the agent's conversation in an interactive terminal, without a new prompt. */
export function resumeLaunchFor(cfg: ProviderCfg, sessionId: string, worktree: string, runDir: string, trustRoot = worktree): Launch {
  const agent = cfg.via === "opencode" ? "opencode" : parseRunnerId(cfg.id)?.agent ?? cfg.id;
  const models = cfg.model ? [agent === "codex" || agent === "opencode" ? "-m" : "--model", cfg.model] : [];
  const argv = agent === "codex" ? ["codex", "-c", codexTrust(worktree, trustRoot), "-c", "check_for_update_on_startup=false", "resume", "--no-daemon", "-C", worktree, "--dangerously-bypass-approvals-and-sandbox", "--add-dir", runDir, ...models, sessionId]
    : agent === "claude-code" ? ["claude", "--dangerously-skip-permissions", ...models, "--resume", sessionId]
    : agent === "cursor" ? ["cursor-agent", "--force", "--sandbox", "disabled", "--workspace", worktree, ...models, "--resume", sessionId]
    : agent === "opencode" ? ["opencode", "--standalone", "--auto", "--session", sessionId] : null;
  if (!argv) throw Error(`no resume launcher for provider "${cfg.id}"`);
  return {cwd: worktree, argv};
}
