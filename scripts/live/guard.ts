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

if (import.meta.main) {
  try {
    const [sessionFile, ...args] = process.argv.slice(2);
    const reason = refusal(args);
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
