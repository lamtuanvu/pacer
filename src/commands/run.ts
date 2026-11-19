// `pacer run` and `pacer step`: start and follow runs, report a step's result
// (plan Task 9). `run` answers and stops read the run's current rev first, like
// dispatch's rev-reading commands; `step result` reports through `step.result`
// in-process, because a delegated executor holds no service client.
import { readFileSync } from "node:fs";
import { connectClient } from "../api/client";
import { assertCallerCanInvoke } from "../api/caller-policy";
import { callOp, type OpDeps } from "../api/ops";
import { commandArgs } from "./accounts";
import type { Command, Result } from "./types";
import type { Ctx } from "../types";

const USAGE = "usage: pacer run start <workflow> --brief <text> [--repo <path>] [--title <t>] | list [--status <s>] | show <id> | answer <id> <step> <answer> | stop <id> [--json]";
const STEP_USAGE = "usage: pacer step result --json '<JSON object>' | --file <path>";

async function call(ctx: Ctx, op: string, params: Record<string, unknown>, deps: OpDeps): Promise<unknown> {
  assertCallerCanInvoke(ctx, op, params);
  const client = await connectClient(ctx, { protocol: 3, opDeps: deps });
  try {
    return client.kind === "inprocess" ? await callOp(ctx, op, params, deps) : await client.call(op, params);
  } finally { client.close(); }
}

/** `--repo` defaults to the repository the CLI runs in (its git top-level). */
async function gitTopLevel(ctx: Ctx): Promise<string | undefined> {
  const r = await ctx.run(["git", "rev-parse", "--show-toplevel"], 10_000);
  const top = r.code === 0 ? r.stdout.trim() : "";
  return top || undefined;
}

interface RunLike { id: string; workflow: string; version: number; status: string; rev: number; reason?: string }
interface StepLike { stepId: string; attempt: number; branch?: string; taskId?: string; status: string; error?: string }

function stepLabel(step: StepLike): string {
  const attempt = step.attempt > 1 ? `#${step.attempt}` : "";
  const branch = step.branch ? `/${step.branch}` : "";
  return `${step.stepId}${attempt}${branch}`;
}

function renderRun(run: RunLike, steps: StepLike[]): string {
  const lines = [`${run.id}  ${run.workflow}@${run.version}  ${run.status}${run.reason ? `  ${run.reason}` : ""}`];
  for (const step of steps) {
    lines.push([stepLabel(step), step.status, step.taskId ?? "-", ...(step.error ? [step.error] : [])].join("  "));
  }
  return lines.join("\n");
}

export async function runCmd(args: string[], ctx: Ctx, deps: OpDeps = {}): Promise<Result> {
  const [sub, ...rest] = args;
  const json = rest.includes("--json");
  try {
    if (sub === "start") {
      const { pos, flags } = commandArgs(rest, ["brief", "repo", "title"], ["json"]);
      if (pos.length !== 1 || !flags.brief) throw Error(USAGE);
      const repo = String(flags.repo ?? await gitTopLevel(ctx) ?? "");
      if (!repo) throw Error("no --repo given and the current directory is not a git repository");
      const params = { workflow: pos[0], repo, brief: String(flags.brief), ...(flags.title ? { title: String(flags.title) } : {}) };
      const run = await call(ctx, "run.start", params, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  ${run.status}`, err: "" };
    }
    if (sub === "list") {
      const { pos, flags } = commandArgs(rest, ["status"], ["json"]);
      if (pos.length) throw Error(USAGE);
      const runs = await call(ctx, "run.list", flags.status ? { status: String(flags.status) } : {}, deps) as RunLike[];
      if (json) return { code: 0, out: JSON.stringify(runs, null, 2), err: "" };
      return { code: 0, out: runs.map(r => `${r.id}  ${r.status}  ${r.workflow}@${r.version}${r.reason ? `  ${r.reason}` : ""}`).join("\n"), err: "" };
    }
    if (sub === "show") {
      const { pos, flags } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike; steps: StepLike[] };
      if (json) return { code: 0, out: JSON.stringify(got, null, 2), err: "" };
      return { code: 0, out: renderRun(got.run, got.steps), err: "" };
    }
    if (sub === "answer" || sub === "stop") {
      const { pos } = commandArgs(rest, [], ["json"]);
      if (sub === "answer" ? pos.length < 3 : pos.length !== 1) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const params = sub === "answer"
        ? { id: pos[0], step: pos[1], answer: pos.slice(2).join(" "), expect_rev: got.run.rev }
        : { id: pos[0], expect_rev: got.run.rev };
      const run = await call(ctx, sub === "answer" ? "run.answer" : "run.stop", params, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  ${run.status}${run.reason ? `  ${run.reason}` : ""}`, err: "" };
    }
    throw Error(USAGE);
  } catch (e) { return { code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** `pacer step result`: the executor-facing report of its workflow step's
 *  structured result. Runs in-process like `pacer ask`, because a delegated
 *  executor session holds no service client; identity is the op's
 *  `requireAskingExecutor`. */
export async function stepCmd(args: string[], ctx: Ctx, deps: OpDeps = {}): Promise<Result> {
  const [sub, ...rest] = args;
  try {
    if (sub !== "result") throw Error(STEP_USAGE);
    const { pos, flags } = commandArgs(rest, ["json", "file"], []);
    if (pos.length || (flags.json ? 1 : 0) + (flags.file ? 1 : 0) !== 1) throw Error(STEP_USAGE);
    let result: unknown;
    if (flags.json) {
      try { result = JSON.parse(String(flags.json)); }
      catch { throw Error("--json needs one JSON object as its value"); }
    } else {
      try { result = JSON.parse(readFileSync(String(flags.file), "utf8")); }
      catch { throw Error(`--file is not readable JSON: ${flags.file}`); }
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw Error("--json must carry a JSON object");
    assertCallerCanInvoke(ctx, "step.result", { result });
    const row = await callOp(ctx, "step.result", { result }, deps);
    return { code: 0, out: JSON.stringify(row, null, 2), err: "" };
  } catch (e) { return { code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` }; }
}

export const COMMANDS: Command[] = [
  { name: "run", usage: "run start <workflow> --brief <text> [--repo <path>] [--title <t>] | list [--status <s>] | show <id> | answer <id> <step> <answer> | stop <id>    start and follow runs", run: (args, ctx) => runCmd(args, ctx) },
  { name: "step", usage: "step result --json <object> | --file <path>    report this task's workflow step result", run: (args, ctx) => stepCmd(args, ctx) },
];
