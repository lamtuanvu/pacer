import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { launchFor, runnerEnv } from "../exec/launch";
import { execProcess, executorEnv, type ExecSpec, type ExecResult } from "../exec/process";
import type { Ctx } from "../types";
import { redactEndpointError, writeEndpointState, type EndpointState } from "./state";

export async function testEndpoint(ctx: Ctx, name: string, deps: {spawn?: (spec: ExecSpec) => Promise<ExecResult>} = {}): Promise<EndpointState> {
  const strategy = loadStrategy(ctx), account = strategy.accounts[name];
  if (!account?.connection) throw Error("a configured endpoint connection is required");
  const runner = Object.values(strategy.runners).find(r => r.account === name && r.agent === "opencode");
  if (!runner) throw Error("endpoint runner not configured");
  const root = join(ctx.pacerHome, "endpoints");
  mkdirSync(root, {recursive: true, mode: 0o700});
  const repo = mkdtempSync(join(root, "test-"));
  let env: Record<string, string | undefined> = {};
  let state: EndpointState;
  try {
    // Resolve credentials through the same launch helpers used by direct tasks.
    env = executorEnv(ctx.env, await runnerEnv(ctx, runner));
    const git = await execProcess({argv: ["git", "init", "-q", repo], cwd: repo, env: executorEnv(ctx.env, {}), timeoutMs: 10000});
    if (git.code !== 0) throw Error("could not create test git repo");
    const launch = launchFor(strategy.providers[runner.id], "Create a file named hello.txt containing exactly: ok", repo, repo, "endpoint-test");
    const result = await (deps.spawn ?? execProcess)({...launch, env, timeoutMs: 120000});
    if (result.timedOut) throw Error("test task timed out");
    if (result.code !== 0) throw Error(result.stderr.trim() || result.stdout.trim() || `test task exited ${result.code}`);
    const file = join(repo, "hello.txt");
    let valid = false;
    try { valid = lstatSync(file).isFile() && readFileSync(file, "utf8") === "ok"; } catch { /* missing output */ }
    if (!valid) throw Error("test task did not create hello.txt containing exactly: ok");
    state = {state: "ready", checked_at: new Date(ctx.now * 1000).toISOString()};
  } catch (error) {
    const secrets = [...Object.entries(env).filter(([k]) => k.startsWith("PACER_KEY_")).map(([,v]) => v ?? ""), ...Object.entries(ctx.env).filter(([k]) => /key|token|secret|password/i.test(k)).map(([,v]) => v ?? "")];
    const detail = redactEndpointError(error instanceof Error ? error.message : String(error), secrets);
    state = {state: "not_working", detail: `test task failed: ${detail || "unknown error"}`};
  } finally { rmSync(repo, {recursive: true, force: true}); }
  writeEndpointState(ctx, name, state);
  return state;
}
