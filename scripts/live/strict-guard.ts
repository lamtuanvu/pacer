import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { pacerArgv, record, sandboxEnv, type Session } from "./core";
import { executorRefusal, refusal } from "./guard";

const reason = "pacer: native subagents are blocked for this managed attempt. Request child work with `pacer dispatch child --goal ... --request-id ...`.";
const cases = [
  { planner: "claude-code", input: '{"tool_name":"Agent"}', deny: true },
  { planner: "codex", input: '{"tool_name":"spawn_agent"}', deny: true },
  { planner: "cursor", input: '{"subagent_type":"Explore"}', deny: true },
  { planner: "claude-code", input: '{"tool_name":"Bash"}', deny: false },
] as const;

function expected(planner: string, deny: boolean): string {
  if (!deny) return "";
  if (planner === "cursor") return JSON.stringify({ permission: "deny", user_message: reason }) + "\n";
  return JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
  } }) + "\n";
}

/** Fixed hook fixture through the same guarded sandbox binary used by live pacer. */
export async function exerciseStrictGuard(session: Session, outer: NodeJS.ProcessEnv): Promise<void> {
  for (const [index, item] of cases.entries()) {
    const args = ["guard", "--planner", item.planner];
    const denied = refusal(args) ?? executorRefusal(args, outer);
    if (denied) throw Error(`Live validation guard refused: ${denied}`);
    const marker = join(session.root, "evidence", `strict-guard-${index}-canary`);
    const failed = join(session.root, "evidence", `strict-guard-${index}-report-failed`);
    const env = { ...sandboxEnv(session), PACER_ROLE: "executor", PACER_ENFORCEMENT_MODE: "strict",
      PACER_ENFORCEMENT_TOKEN: "invalid", PACER_CANARY_MARKER: marker, PACER_GUARD_FAILURE_MARKER: failed };
    const argv = [...pacerArgv(session), ...args];
    const child = Bun.spawn(argv, {
      cwd: join(session.root, "repo"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    await child.stdin.write(item.input);
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    record(session, { kind: "command", argv, code, stdout, stderr });
    const markers = !item.deny || (readFileSync(marker, "utf8") === "native-child.denied"
      && readFileSync(failed, "utf8") === "guard-report-failed");
    if (code !== 0 || stdout !== expected(item.planner, item.deny) || stderr || !markers) {
      throw Error(`strict guard fixture failed for ${item.planner}: exit ${code}, stdout ${stdout}, stderr ${stderr}`);
    }
    console.log(`${item.planner}: ${item.deny ? "deny" : "allow"}, exit ${code}`);
  }
  const args = ["guard", "--planner", "codex"];
  const denied = refusal(args) ?? executorRefusal(args, outer);
  if (denied) throw Error(`Live validation guard refused: ${denied}`);
  const base = { ...sandboxEnv(session), PACER_ROLE: "executor", PACER_ENFORCEMENT_MODE: "strict" };
  const check = async (label: string, env: NodeJS.ProcessEnv, closeInput: boolean) => {
    const argv = [...pacerArgv(session), ...args];
    const child = Bun.spawn(argv, { cwd: join(session.root, "repo"), env,
      stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      if (closeInput) { await child.stdin.write('{"tool_name":"spawn_agent"}'); await child.stdin.end(); }
      const code = await Promise.race([child.exited, Bun.sleep(3000).then(() => -1)]);
      if (code !== 0) throw Error(`${label} timed out or exited ${code}`);
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      record(session, { kind: "command", argv, code, stdout, stderr });
      if (stdout !== expected("codex", true) || stderr || readFileSync(env.PACER_GUARD_FAILURE_MARKER!, "utf8") !== "guard-report-failed")
        throw Error(`${label} produced the wrong denial or failure marker`);
      console.log(`${label}: deny, exit ${code}, failure marker present`);
    } finally { child.kill(); await child.exited; }
  };
  await check("open stdin", { ...base, PACER_ENFORCEMENT_TOKEN: "invalid",
    PACER_GUARD_FAILURE_MARKER: join(session.root, "evidence", "strict-guard-open-report-failed") }, false);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not-json");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("strict guard fixture has no loopback port");
    await check("malformed denial response", { ...base, PACER_ENFORCEMENT_TOKEN: `pet_${"0".repeat(64)}`,
      PACER_PORT: String(address.port),
      PACER_GUARD_FAILURE_MARKER: join(session.root, "evidence", "strict-guard-malformed-report-failed") }, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
