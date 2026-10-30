import { refusedOp } from "./proxy";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pacerArgv, sandboxEnv, type Session } from "./core";

/** D3 applies before dispatch, including calls made by the TUI or task runner. */
export function refusal(args: string[]): string | undefined {
  const [command, action] = args;
  if (command === "api" && action === "--stdio") return "D3: stdio can execute local operations; use api call through the guarded service";
  if (command === "api" && action === "call") {
    let name: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (["--params", "--params-file"].includes(args[i])) { i++; continue; }
      if (!args[i].startsWith("-")) { name = args[i]; break; }
    }
    if (!name || refusedOp("POST", `/v3/ops/${name}`)) return "D3: generic operation changes the real user environment";
  }
  if (command === "desktop-update" && action !== "status") return "D3: desktop update requires a verified OTA fixture";
  if (["integrations", "install", "uninstall", "init", "setup", "statusline", "update", "orca"].includes(command)) return `D3: ${command} changes the real user environment`;
  const blocked: Record<string, string[]> = { service: ["install", "uninstall"], plugin: ["uninstall", "remove"], account: ["add", "rm", "login"], host: ["setup"] };
  if (blocked[command]?.includes(action)) return `D3: ${command} ${action} changes the real user environment`;
  if (command === "open" && !args.includes("--print")) return "D3: open requires --print; use the agent's browser tools";
  return undefined;
}

/** CLI commands and API operations that start or re-start executor work. */
const DELEGATION_OPS = ["task.delegate", "task.retry", "task.retry_all", "dispatch.submit", "dispatch.child", "dispatch.retry"];
function delegates(args: string[]): string | undefined {
  const [command, action] = args;
  if (command === "delegate" || command === "retry") return command;
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
