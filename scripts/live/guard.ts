import { CONDITIONAL_OPS, refusedOp } from "./proxy";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pacerArgv, sandboxEnv, type Session } from "./core";
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
    if (plain === parsed && READ_ONLY_REPO_FORMS.includes(plain ?? "")) continue;
    if (tail.includes("map")) return "D3: host repo map changes the real user environment (D8 refuses host.repo.map)";
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
  const blocked: Record<string, string[]> = { service: ["install", "uninstall"], plugin: ["uninstall", "remove"], account: ["add", "rm", "login"] };
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
 * Executor sessions must not delegate onward, even inside a sandbox. The sandbox does not inherit the outer
 * PACER_ROLE or PACER_TASK_ID (sandboxEnv drops them), so the guard checks the outer environment itself.
 */
export function executorRefusal(args: string[], outer: NodeJS.ProcessEnv): string | undefined {
  if (outer.PACER_ROLE !== "executor" && !outer.PACER_TASK_ID) return undefined;
  const what = delegates(args);
  return what ? `executor sessions cannot delegate onward (${what}); run real delegation from a planner session` : undefined;
}

if (import.meta.main) {
  try {
    const [sessionFile, ...args] = process.argv.slice(2);
    const reason = refusal(args) ?? executorRefusal(args, process.env);
    if (reason) {
      console.error(`Live validation guard refused: ${reason}`);
      process.exit(3);
    }
    const session = JSON.parse(readFileSync(sessionFile, "utf8")) as Session;
    if (args.length === 3 && args[0] === "plugin" && args[1] === "run" && args[2] === "pacer-ssh") {
      process.exit(await runSessionStreamFaultProxy(session, args));
    }
    const child = Bun.spawn([...pacerArgv(session), ...args], {
      cwd: join(session.root, "repo"), env: sandboxEnv(session), stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    // Forward shutdown to the guarded process, including nested task runners.
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
    process.exit(await child.exited);
  } catch (error) {
    console.error(`Live validation guard: ${(error as Error).message}`);
    process.exit(1);
  }
}
