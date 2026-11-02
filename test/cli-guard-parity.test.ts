import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const front = process.env.PACER_TEST_FRONT_DOOR;
const cli = join(import.meta.dir, "../src/cli.ts");
const reason = "pacer: native subagents are blocked for this managed attempt. Request child work with `pacer dispatch child --goal ... --request-id ...`.";
const denial = (planner: string) => planner === "cursor"
  ? JSON.stringify({ permission: "deny", user_message: reason }) + "\n"
  : JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n";

test.skipIf(!front)("strict executor guard has byte-exact TS frames and exit codes", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-cli-guard-"));
  try {
    const cases = [
      { planner: "claude-code", stdin: '{"tool_name":"Agent"}', expected: denial("claude-code") },
      { planner: "claude-code", stdin: '{"tool_name":"Task"}', expected: denial("claude-code") },
      { planner: "codex", stdin: '{"tool_name":"spawn_agent"}', expected: denial("codex") },
      { planner: "cursor", stdin: '{"subagent_type":"Explore"}', expected: denial("cursor") },
      { planner: "claude-code", stdin: "bad json", expected: denial("claude-code") },
      { planner: "codex", stdin: "{}", expected: denial("codex"), emptyMarkers: true },
      { planner: "claude-code", stdin: '{"tool_name":"Bash"}', expected: "" },
      { planner: "cursor", stdin: '{"tool_name":"Bash"}', expected: '{"permission":"allow"}\n' },
      { planner: "unknown", stdin: "bad json", expected: "" },
    ];
    for (const [index, item] of cases.entries()) {
      const args = ["guard", "--planner", item.planner];
      const makeEnv = (runtime: string) => { const home = join(root, `${index}-${runtime}`); mkdirSync(home, { recursive: true }); return { ...process.env, HOME: home, PACER_HOME: join(home, ".pacer"), PACER_ROLE: "executor",
        PACER_ENFORCEMENT_MODE: "strict", PACER_ENFORCEMENT_TOKEN: "invalid", PACER_PORT: "0",
        PACER_CANARY_MARKER: join(home, "canary"), PACER_GUARD_FAILURE_MARKER: join(home, "failed"),
        PACER_CORE_ARGV: JSON.stringify([process.execPath, cli]), PACER_NO_SELF_REPAIR: "1" }; };
      const tsEnv = makeEnv("ts"), rustEnv = makeEnv("rust");
      if ("emptyMarkers" in item) {
        tsEnv.PACER_CANARY_MARKER = rustEnv.PACER_CANARY_MARKER = "";
        tsEnv.PACER_GUARD_FAILURE_MARKER = rustEnv.PACER_GUARD_FAILURE_MARKER = "";
      }
      const run = (program: string, env: typeof tsEnv, prefix: string[] = []) => spawnSync(program, [...prefix, ...args], {
        env, input: item.stdin, encoding: "utf8", timeout: 5000,
      });
      const ts = run(process.execPath, tsEnv, [cli]);
      const rust = run(front!, rustEnv);
      const frame = (result: ReturnType<typeof run>) => [result.status, result.stdout, result.stderr];
      expect(frame(rust), `${index}: ${item.planner}`).toEqual(frame(ts));
      expect(rust.status).toBe(0);
      expect(rust.stdout).toBe(item.expected);
      if (item.expected.includes("deny") && !("emptyMarkers" in item)) {
        expect(readFileSync(rustEnv.PACER_CANARY_MARKER, "utf8")).toBe("native-child.denied");
        expect(readFileSync(rustEnv.PACER_GUARD_FAILURE_MARKER, "utf8")).toBe("guard-report-failed");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test.skipIf(!front)("strict guard reports the same authenticated denial request", async () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-cli-guard-report-"));
  const requests: Array<{url: string | undefined; authorization: string | undefined; body: string}> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk.toString(); });
    request.on("end", () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body });
      response.writeHead(200, {"content-type":"application/json"});
      response.end('{"result":{}}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("no test port");
    const token = `pet_${"0".repeat(64)}`;
    const run = async (program: string, runtime: string, prefix: string[] = []) => {
      const home = join(root, runtime); mkdirSync(home);
      const env = { ...process.env, HOME: home, PACER_HOME: join(home, ".pacer"),
        PACER_ROLE:"executor", PACER_ENFORCEMENT_MODE:"strict", PACER_ENFORCEMENT_TOKEN:token,
        PACER_PORT:String(address.port), PACER_CANARY_MARKER:join(home,"canary"),
        PACER_GUARD_FAILURE_MARKER:join(home,"failed"),
        PACER_CORE_ARGV: JSON.stringify([process.execPath, cli]), PACER_NO_SELF_REPAIR:"1" };
      const child = Bun.spawn([program, ...prefix, "guard", "--planner", "codex"], {
        env, stdin:"pipe", stdout:"pipe", stderr:"pipe",
      });
      await child.stdin.write('{"tool_name":"spawn_agent"}'); await child.stdin.end();
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(existsSync(env.PACER_GUARD_FAILURE_MARKER)).toBe(false);
      expect(readFileSync(env.PACER_CANARY_MARKER,"utf8")).toBe("native-child.denied");
      return [status, stdout, stderr];
    };
    expect(await run(front!, "rust")).toEqual(await run(process.execPath, "ts", [cli]));
    expect(requests).toEqual(Array.from({length:2}, () => ({
      url:"/v3/ops/dispatch.enforcement.denied", authorization:`Bearer ${token}`, body:'{"agent":"codex"}',
    })));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, {recursive:true, force:true});
  }
}, 15000);

test.skipIf(!front)("other CLI commands and ordinary guards stay forwarded", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-cli-routing-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, PACER_HOME: join(root, ".pacer"),
      PACER_CORE_ARGV: JSON.stringify([process.execPath, cli]), PACER_NO_SELF_REPAIR: "1" };
    delete env.PACER_WORK_GRANT;
    delete env.PACER_ENFORCEMENT_MODE;
    const cases = [
      { args: ["help"], stdin: "" },
      { args: ["guard", "--planner", "cursor"], stdin: "bad json" },
      { args: ["guard", "--planner", "claude-code"], stdin: '{"tool_name":"Agent"}' },
      { args: ["unknown-command"], stdin: "" },
    ];
    for (const { args, stdin } of cases) {
      const run = (program: string, prefix: string[] = []) => spawnSync(program, [...prefix, ...args], {
        env, input: stdin, encoding: "utf8", timeout: 5000,
      });
      const ts = run(process.execPath, [cli]), rust = run(front!);
      expect([rust.status, rust.stdout, rust.stderr]).toEqual([ts.status, ts.stdout, ts.stderr]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);

test.skipIf(!front)("work-grant guard gate preserves TS exit and stderr", () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-cli-guard-grant-"));
  try {
    const env = { ...process.env, HOME: root, PACER_HOME: join(root,".pacer"),
      PACER_ROLE:"executor", PACER_ENFORCEMENT_MODE:"strict", PACER_ENFORCEMENT_TOKEN:"",
      PACER_WORK_GRANT:"grant", PACER_CORE_ARGV:JSON.stringify([process.execPath,cli]), PACER_NO_SELF_REPAIR:"1" };
    const args = ["guard", "--planner", "codex"];
    const run = (program:string, prefix:string[] = []) => spawnSync(program,[...prefix,...args],{
      env, input:'{"tool_name":"spawn_agent"}', encoding:"utf8", timeout:5000,
    });
    const ts = run(process.execPath,[cli]), rust = run(front!);
    expect([rust.status,rust.stdout,rust.stderr]).toEqual([ts.status,ts.stdout,ts.stderr]);
    expect([rust.status,rust.stdout,rust.stderr]).toEqual([2,"","pacer: work grants only allow scoped dispatch commands\n"]);
  } finally { rmSync(root,{recursive:true,force:true}); }
}, 10000);
