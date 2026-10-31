import { mkdirSync, writeFileSync } from "node:fs";
import { parseRunnerId, resolveRunner } from "../config/runner-id";
import { join } from "node:path";
import { loadStrategy, MissingStrategyError, type ProviderCfg } from "../config/strategy";
import type { RunnerCfg } from "../config/accounts";
import type { ExecutionCfg, LaunchMode } from "../config/execution";
import type { Ctx } from "../types";
import { endpointKeyEnv, readKey } from "../endpoints/keys";
import { endpointLaunchSettings } from "../plugins/endpoint-adapter";
import { orcaAccountHome } from "../orca/accounts";
import { ensureManagedClaudeStatusLine } from "../install/claude-managed-telemetry";

/** Resolve account settings and read endpoint credentials only when launching a child. */
export async function runnerEnv(ctx: Ctx, runner: RunnerCfg, probe = false): Promise<Record<string, string>> {
  const strategy = loadStrategy(ctx), account = strategy.accounts[runner.account];
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
    const settings = await endpointLaunchSettings(ctx, strategy.accounts, account.name);
    return {...opencodeEnv, ...settings.env, ...(key ? {[endpointKeyEnv(account.name)]: key} : {})};
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

const INTERACTIVE_AGENTS = ["opencode", "codex", "claude-code", "cursor", "agy"];
export interface LaunchModeChoice { mode: LaunchMode; explicit: boolean; fallback?: string }

/** Strict delegation enforcement certifies headless launches only. */
export const MANAGED_HEADLESS = "managed dispatch with strict delegation enforcement runs headless";

/**
 * Runner `session:` > execution.launch_mode > interactive. Only a default-derived interactive mode falls back
 * to headless; `managed` (strict delegation enforcement) keeps it headless as before interactive became the default.
 */
export function launchModeFor(cfg: Pick<ProviderCfg, "id" | "via" | "session">, exec: Pick<ExecutionCfg, "launchMode">, options: {managed?: boolean} = {}): LaunchModeChoice {
  if (cfg.session) return {mode: cfg.session, explicit: true};
  const mode = exec.launchMode ?? "interactive", parsed = parseRunnerId(cfg.id), agent = cfg.via === "opencode" ? "opencode" : parsed?.agent ?? cfg.id;
  if (mode === "headless") return {mode, explicit: false};
  if (options.managed) return {mode: "headless", explicit: false, fallback: MANAGED_HEADLESS};
  if (parsed?.host) return {mode: "headless", explicit: false, fallback: "remote runners run headless"};
  if (!INTERACTIVE_AGENTS.includes(agent)) return {mode: "headless", explicit: false, fallback: `no interactive launcher for ${agent}`};
  return {mode, explicit: false};
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

/** An interactive prompt over 32 KiB is passed as a run file; the argv names the file instead. */
export const INTERACTIVE_PROMPT_BYTES = 32 * 1024;
export const promptFileInstruction = (promptFile: string) =>
  `Read the complete task instructions in ${JSON.stringify(promptFile)} and carry them out.`;

export function launchFor(cfg: ProviderCfg, prompt: string, repo: string, taskDir: string, taskId: string, sessionId?: string, trustRoot = repo): Launch {
  const model = cfg.model;
  if (cfg.session === "interactive") {
    if (Buffer.byteLength(prompt, "utf8") > INTERACTIVE_PROMPT_BYTES) {
      mkdirSync(taskDir, {recursive: true, mode: 0o700});
      const promptFile = join(taskDir, "prompt.md");
      writeFileSync(promptFile, prompt, {mode: 0o600});
      prompt = promptFileInstruction(promptFile);
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

const HEADLESS_RESUME = ["codex", "claude-code", "cursor"], HEADLESS_LAUNCH = [...HEADLESS_RESUME, "agy"];
/** How a message turn reaches this runner headless: resume its session, replay the thread in a fresh launch, or not at all. */
export function headlessTurnPath(cfg: Pick<ProviderCfg, "id" | "via">): "resume" | "replay" | null {
  if (parseRunnerId(cfg.id)?.host) return null;
  if (cfg.via === "opencode") return "resume";
  const agent = parseRunnerId(cfg.id)?.agent ?? cfg.id;
  return HEADLESS_RESUME.includes(agent) ? "resume" : HEADLESS_LAUNCH.includes(agent) ? "replay" : null;
}

/** Continue a headless agent's native session with one new prompt; the process exits when the turn ends. */
export function resumeHeadlessFor(cfg: ProviderCfg, sessionId: string, prompt: string, workdir: string, taskDir: string, taskId: string): Launch {
  const model = cfg.model;
  if (cfg.via === "opencode") {
    return {cwd: workdir, argv: ["opencode", "run", "--standalone", "--agent", "build", ...(model ? ["-m", model] : []), "--auto", "--session", sessionId, prompt]};
  }
  switch (parseRunnerId(cfg.id)?.agent ?? cfg.id) {
    case "codex": {
      // `codex exec resume` has no -C; the cwd selects the worktree.
      const lastMessageFile = join(taskDir, `${taskId}.codex-last.md`);
      return {
        cwd: workdir, stdin: prompt, lastMessageFile,
        argv: ["codex", "exec", "resume", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-o", lastMessageFile, ...(model ? ["-m", model] : []), sessionId, "-"],
      };
    }
    case "claude-code":
      return {cwd: workdir, argv: ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose", "--resume", sessionId, ...(model ? ["--model", model] : []), prompt]};
    case "cursor":
      return {cwd: workdir, argv: ["cursor-agent", "-p", "--output-format", "text", "--force", "--sandbox", "disabled", "--workspace", workdir, "--resume", sessionId, ...(model ? ["--model", model] : []), prompt]};
    default:
      throw new Error(`no headless resume for provider "${cfg.id}"`);
  }
}
