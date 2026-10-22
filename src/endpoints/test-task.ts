import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRunner } from "../config/runner-id";
import { loadStrategy } from "../config/strategy";
import { launchFor, runnerEnv } from "../exec/launch";
import { execProcess, executorEnv, type ExecSpec, type ExecResult } from "../exec/process";
import type { Ctx } from "../types";
import { captureClaudeStreamUsage } from "../usage/claude";
import { configProviders, signedInProviders } from "./detect";
import { redactEndpointError, writeEndpointState, type EndpointState } from "./state";

export interface TestTaskDeps { spawn?: (spec: ExecSpec) => Promise<ExecResult> }

/** Runs a small task in a disposable repository, never in a user's checkout. */
export async function runTestTask(ctx: Ctx, runnerId: string, deps: TestTaskDeps = {}): Promise<void> {
  return runInTestRepo(ctx, runnerId, deps, "scratch", 180000);
}

async function runInTestRepo(ctx: Ctx, runnerId: string, deps: TestTaskDeps, directory: string, timeoutMs: number): Promise<void> {
  const strategy = loadStrategy(ctx), runner = resolveRunner(strategy, runnerId);
  if (!runner) throw Error("runner not configured");
  if (runner.host) throw Error("remote runner test tasks are not supported yet");
  const root = join(ctx.pacerHome, directory);
  mkdirSync(root, {recursive: true, mode: 0o700});
  const repo = mkdtempSync(join(root, "test-"));
  let env: Record<string, string | undefined> = {};
  try {
    env = executorEnv(ctx.env, await runnerEnv(ctx, runner));
    const git = await execProcess({argv: ["git", "init", "-q", repo], cwd: repo, env: executorEnv(ctx.env, {}), timeoutMs: 10000});
    if (git.code !== 0) throw Error("could not create test git repo");
    const provider = strategy.providers[runner.id];
    const launch = launchFor(runner.agent === "claude-code" ? {...provider, session: "headless"} : provider,
      "Create a file named hello.txt containing exactly: ok", repo, repo, "endpoint-test");
    if (runner.agent === "claude-code") {
      // Headless sessions do not run status lines. Claude's own stream includes
      // account-scoped quota telemetry after its first API response.
      launch.argv[launch.argv.indexOf("--output-format") + 1] = "stream-json";
      if (!launch.argv.includes("--verbose")) launch.argv.push("--verbose");
    }
    const result = await (deps.spawn ?? execProcess)({...launch, env, timeoutMs});
    if (runner.agent === "claude-code") captureClaudeStreamUsage(ctx, strategy.accounts[runner.account], result.stdout);
    if (result.timedOut) throw Error("test task timed out");
    if (result.code !== 0) throw Error(result.stderr.trim() || result.stdout.trim() || `test task exited ${result.code}`);
    const file = join(repo, "hello.txt");
    let valid = false;
    try { valid = lstatSync(file).isFile() && readFileSync(file, "utf8") === "ok"; } catch { /* missing output */ }
    if (!valid) throw Error("test task did not create hello.txt containing exactly: ok");
  } catch (error) {
    const secrets = [...Object.entries(env).filter(([k]) => k.startsWith("PACER_KEY_")).map(([,v]) => v ?? ""), ...Object.entries(ctx.env).filter(([k]) => /key|token|secret|password/i.test(k)).map(([,v]) => v ?? "")];
    const detail = redactEndpointError(error instanceof Error ? error.message : String(error), secrets);
    throw Error(`test task failed: ${detail || "unknown error"}`);
  } finally { rmSync(repo, {recursive: true, force: true}); }
}

export async function testEndpoint(ctx: Ctx, name: string, deps: TestTaskDeps = {}): Promise<EndpointState> {
  const strategy = loadStrategy(ctx), account = strategy.accounts[name];
  if (!account?.connection && account?.source !== "opencode") throw Error("a configured endpoint connection is required");
  if (account.source === "opencode" && account.provider) {
    const signed = await signedInProviders(ctx);
    const configured = configProviders(ctx).some(p => p.id === account.provider);
    if (signed !== null && !configured && !signed.some(p => p.id === account.provider)) {
      const missing: EndpointState = {state: "key_missing", detail: `Run opencode auth login ${account.provider}`};
      writeEndpointState(ctx, name, missing);
      return missing;
    }
  }
  const runner = Object.values(strategy.runners).find(r => r.account === name && r.agent === "opencode");
  if (!runner) throw Error("endpoint runner not configured");
  let state: EndpointState;
  try {
    // Preserve the endpoint test's existing repository location and timeout.
    await runInTestRepo(ctx, runner.id, deps, "endpoints", 120000);
    state = {state: "ready", checked_at: new Date(ctx.now * 1000).toISOString()};
  } catch (error) {
    state = {state: "not_working", detail: error instanceof Error ? error.message : String(error)};
  }
  writeEndpointState(ctx, name, state);
  return state;
}
