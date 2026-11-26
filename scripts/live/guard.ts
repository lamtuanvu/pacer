import { CONDITIONAL_OPS, refusedOp } from "./proxy";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isolatedArgv, pacerArgv, SANDBOX_MARK, sandboxEnv, type Session } from "./core";
import { runSessionStreamFaultProxy } from "./session-stream-fault";

/**
 * The CLI's `config set` always passes `integrations: "install"` to config.set in-process, so D8 never sees it.
 * Any spelling that names the planner after `set` is refused, even ones the CLI would reject itself.
 */
function configSetsPlanner(args: string[]): boolean {
  const words = args.filter(arg => arg !== "--");
  const set = words.indexOf("set");
  return words[0] === "config" && set > 0 && words.slice(set + 1).some(arg => /^-*planner\b/i.test(arg.trim()));
}

/** CLI forms of the host operations D8 refuses over the API. The sandbox ssh runs remote programs locally. */
const HOST_FORMS: Readonly<Record<string, string>> = {
  "add": "host.add", "account add": "host.account.add", "setup": "host.repo.setup", "clean": "host.clean", "terminal": "host.terminal",
};
/** `host repo` admits only these read-only subcommands; every other one is refused. */
const READ_ONLY_REPO_FORMS = ["list", "check"];
/**
 * The first positional after `repo`, read two ways: skipping every dash word, and as the CLI's `parseFlags`
 * reads it (`--x` takes the next word unless it is the boolean `--json`). Both readings must agree.
 */
function repoSubcommands(tail: string[]): [string | undefined, string | undefined] {
  let parsed: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    if (!tail[i].startsWith("--")) { parsed = tail[i]; break; }
    if (tail[i] !== "--json") i++;
  }
  return [tail.find(arg => !arg.startsWith("-")), parsed];
}
function hostRefusal(args: string[]): string | undefined {
  // The CLI accepts flags before the action and flag values look like words, so every word is a candidate.
  const words = args.slice(1).filter(arg => !arg.startsWith("-"));
  for (let i = 0; i < words.length; i++) {
    const form = [`${words[i]} ${words[i + 1]}`, words[i]].find(candidate => Object.hasOwn(HOST_FORMS, candidate));
    if (form) return `D3: host ${form} changes the real user environment (D8 refuses ${HOST_FORMS[form]})`;
  }
  for (let i = 1; i < args.length; i++) {
    if (args[i] !== "repo") continue;
    const tail = args.slice(i + 1), [plain, parsed] = repoSubcommands(tail);
    if (tail.includes("map")) return "D3: host repo map changes the real user environment (D8 refuses host.repo.map)";
    if (plain === parsed && READ_ONLY_REPO_FORMS.includes(plain ?? "")) continue;
    return `D3: host repo admits only the read-only ${READ_ONLY_REPO_FORMS.join(" and ")} subcommands`;
  }
}

/** D3 applies before dispatch, including calls made by the TUI or task runner. */
export function refusal(args: string[]): string | undefined {
  const [command, action] = args;
  if (command === "api" && action === "--stdio") return "D3: stdio can execute local operations; use api call through the guarded service";
  if (command === "api" && action === "call") {
    let name: string | undefined;
    const inline: string[] = [];
    let file = false;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--params") { inline.push(args[++i] ?? ""); continue; }
      if (args[i] === "--params-file") { file = true; i++; continue; }
      if (!name && !args[i].startsWith("-")) name = args[i];
    }
    // A params file cannot be inspected here; a single inline body must pass the same D8 body rule.
    const admitted = name && Object.hasOwn(CONDITIONAL_OPS, name) && !file && inline.length === 1 && CONDITIONAL_OPS[name](inline[0]);
    if (!name || (refusedOp("POST", `/v3/ops/${name}`) && !admitted)) return "D3: generic operation changes the real user environment";
  }
  if (configSetsPlanner(args)) return "D3: config set planner installs planner integrations in-process, bypassing D8";
  if (command === "desktop-update" && action !== "status") return "D3: desktop update requires a verified OTA fixture";
  if (["integrations", "install", "uninstall", "init", "setup", "statusline", "update", "orca"].includes(command)) return `D3: ${command} changes the real user environment`;
  // plugin install/update/uninstall now reach the real Orca app (ADR 2026-11-19): pacer shells
  // out to `orca plugin install/update/uninstall` for its own panel, unlike the pre-revival
  // no-op that only explained the removal. Only `status` stays read-only enough to allow.
  const blocked: Record<string, string[]> = { service: ["install", "uninstall"], plugin: ["install", "update", "uninstall", "remove"], account: ["add", "rm", "login"] };
  if (blocked[command]?.includes(action)) return `D3: ${command} ${action} changes the real user environment`;
  if (command === "host") return hostRefusal(args);
  if (command === "open" && !args.includes("--print")) return "D3: open requires --print; use the agent's browser tools";
  return undefined;
}

/** CLI commands and API operations that start or re-start executor work. */
const DELEGATION_OPS = ["task.delegate", "task.retry", "task.retry_all", "task.answer", "task.takeover", "dispatch.submit", "dispatch.child", "dispatch.retry", "dispatch.answer", "session.create", "session.resume", "session.agent.create", "session.agent.retry", "session.agent.resume", "doctor.fix.delegate"];
function delegates(args: string[]): string | undefined {
  const [command, action] = args;
  if (command === "delegate" || command === "retry" || command === "answer" || command === "_run") return command;
  if (command === "review" && args.some(arg => arg === "--send-back" || arg === "--retry-on" || arg.startsWith("--retry-on="))) return "review --send-back/--retry-on";
  if (command === "dispatch" && ["submit", "child", "retry"].includes(action)) return `dispatch ${action}`;
  if (command !== "api" || action !== "call") return undefined;
  let name: string | undefined, params: string | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--params") { params = args[++i]; continue; }
    if (args[i] === "--params-file") { params = undefined; i++; continue; }
    if (!name && !args[i].startsWith("-")) name = args[i];
  }
  if (name && DELEGATION_OPS.includes(name)) return name;
  if (name === "task.review") {
    // Only accept and reject are safe; send_back and retry re-delegate, and a params file cannot be inspected here.
    try { if (["accept", "reject"].includes((JSON.parse(params ?? "") as { verdict?: unknown }).verdict as string)) return undefined; } catch {}
    return "task.review without an inline accept or reject verdict";
  }
  return undefined;
}
/**
 * Executor sessions must not delegate onward, even inside a sandbox. sandboxEnv drops the inherited
 * PACER_ROLE and PACER_TASK_ID, so the guard checks the environment it was called with. `sandboxLaunched`
 * says that environment belongs to a process of this sandbox, whose orchestrator may answer its run's questions.
 */
export function executorRefusal(args: string[], outer: NodeJS.ProcessEnv, sandboxLaunched = false): string | undefined {
  if (outer.PACER_ROLE !== "executor" && !outer.PACER_TASK_ID) return undefined;
  // The CLI takes the first positional as the target, so a `q_` id right after `answer` is never a task.
  if (sandboxLaunched && outer.PACER_ROLE === "orchestrator" && args[0] === "answer" && args[1]?.startsWith("q_")) return undefined;
  const what = delegates(args);
  return what ? `executor sessions cannot delegate onward (${what}); run real delegation from a planner session` : undefined;
}

/** What pacer sets on the executors, canaries, orchestrator turns and planner resumes it launches. */
const IDENTITY_KEYS = [
  "PACER_ROLE", "PACER_TASK_ID", "PACER_WORK_GRANT", "PACER_RUN_GRANT", "PACER_RUN_ID", "PACER_TURN_ID",
  "PACER_ENFORCEMENT_MODE", "PACER_ENFORCEMENT_TOKEN", "PACER_REPORT_TOKEN", "PACER_PLANNER_SESSION", "PACER_CALLER_RESUME",
] as const;
/** Identity values pacer writes to or derives a home from; each must stay inside the sandbox home. */
const HOME_PATH_KEYS = ["PACER_RUN_DIR", "PACER_TRANSCRIPT_REPORT", "PACER_GUARD_FAILURE_MARKER"] as const;

/**
 * The real path of `path`, resolving its existing part; undefined for relative paths, dangling links and `..`,
 * which resolves lexically here but after a symlink in the kernel.
 */
function realTarget(path: string): string | undefined {
  if (!isAbsolute(path) || path.split(sep).includes("..")) return undefined;
  const missing: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try { lstatSync(at); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) return undefined;
      missing.unshift(basename(at));
      continue;
    }
    try { return join(realpathSync(at), ...missing); } catch { return undefined; }
  }
}
function within(path: string, directory: string): boolean {
  const target = realTarget(path), root = realTarget(directory);
  if (!target || !root) return false;
  const rest = relative(root, target);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`);
}
function sandboxHomeOrWithin(session: Session, path: string): boolean {
  const home = join(session.root, "home");
  return within(path, home) || realTarget(path) === realTarget(home);
}

/** True only for the environment of a process this sandbox launched: its launch mark and its own home. */
export function sandboxLaunched(session: Session, inherited: NodeJS.ProcessEnv): boolean {
  if (inherited[SANDBOX_MARK] !== session.root || !inherited.PACER_HOME) return false;
  const home = realTarget(inherited.PACER_HOME);
  return home !== undefined && home === realTarget(join(session.root, "home"));
}

/** The identity a sandbox-launched caller keeps. Anything else, and every outer identity, is dropped. */
function sandboxIdentity(session: Session, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!sandboxLaunched(session, inherited)) return {};
  const home = join(session.root, "home"), kept: NodeJS.ProcessEnv = {};
  for (const key of IDENTITY_KEYS) if (inherited[key] !== undefined) kept[key] = inherited[key];
  for (const key of HOME_PATH_KEYS) {
    const path = inherited[key];
    if (path && within(path, home)) kept[key] = path;
  }
  // The certification canary's marker lives in the probe's own temporary directory, not in the home.
  const marker = inherited.PACER_CANARY_MARKER;
  if (marker && within(marker, session.tmp ?? tmpdir()) && basename(dirname(marker)).startsWith("pacer-control-canary-") && basename(marker).startsWith("denied-")) {
    kept.PACER_CANARY_MARKER = marker;
  }
  return kept;
}

/**
 * The guarded child's directory: the caller's when its real path is in the sandbox home (task worktrees live
 * there) or repo, so its relative paths mean what it wrote; the sandbox repo for any other caller.
 */
export function guardedChildCwd(session: Session, cwd: string): string {
  const repo = join(session.root, "repo");
  const real = realTarget(cwd);
  if (!real || !existsSync(real)) return repo;
  return [join(session.root, "home"), repo].some(root => real === realTarget(root) || within(real, root)) ? real : repo;
}

/**
 * Env for the guarded child. Normally the sandbox env alone. For `mcp --assistant`, Claude (or the host)
 * sets PACER_ASSISTANT_* and a turn PACER_HOME on this process via `--mcp-config` env expansion; those
 * must reach the MCP server or it registers no tools (ask-mode self-test / CONTROL init fail closed).
 */
export function guardedChildEnv(
  session: Session,
  args: string[],
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sandboxEnv(session), ...sandboxIdentity(session, inherited) };
  // The sandbox sits inside the checkout, so git must not search above it from a folder with no repository.
  env.GIT_CEILING_DIRECTORIES = [session.root, env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(delimiter);
  if (env.PACER_CORE_ARGV) env.PACER_CORE_ARGV = JSON.stringify(isolatedArgv(JSON.parse(env.PACER_CORE_ARGV) as string[]));
  if (args[0] !== "mcp" || args[1] !== "--assistant") return env;
  const pass = ["PACER_ASSISTANT_GRANT", "PACER_ASSISTANT_URL", "PACER_ASSISTANT_TURN", "PACER_HOME", "PACER_ASSISTANT_HOME"] as const;
  for (const key of pass) {
    const value = inherited[key];
    // A turn's home is a folder of the sandbox home; an outside one would point the server at another install.
    if (typeof value !== "string" || value.length === 0 || (key.endsWith("_HOME") && !sandboxHomeOrWithin(session, value))) continue;
    env[key] = value;
  }
  return env;
}

if (import.meta.main) {
  try {
    const [sessionFile, ...args] = process.argv.slice(2);
    let session: Session | undefined, unreadable: unknown;
    try { session = JSON.parse(readFileSync(sessionFile, "utf8")) as Session; } catch (error) { unreadable = error; }
    // Refusals come first: without a readable session the caller counts as an outer one.
    const reason = refusal(args) ?? executorRefusal(args, process.env, !!session && sandboxLaunched(session, process.env));
    if (reason) {
      console.error(`Live validation guard refused: ${reason}`);
      process.exit(3);
    }
    if (!session) throw unreadable;
    if (args.length === 3 && args[0] === "plugin" && args[1] === "run" && args[2] === "pacer-ssh") {
      process.exit(await runSessionStreamFaultProxy(session, args));
    }
    const child = Bun.spawn([...isolatedArgv(pacerArgv(session)), ...args], {
      cwd: guardedChildCwd(session, process.cwd()), env: guardedChildEnv(session, args), stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    // Forward shutdown to the guarded process, including nested task runners.
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
    process.exit(await child.exited);
  } catch (error) {
    console.error(`Live validation guard: ${(error as Error).message}`);
    process.exit(1);
  }
}
