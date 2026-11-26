// `pacer run` and `pacer step`: start and follow runs, report a step's result
// (plan Task 9). `run` answers and stops read the run's current rev first, like
// dispatch's rev-reading commands; `step result` reports through `step.result`
// in-process, because a delegated executor holds no service client.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectClient } from "../api/client";
import { assertCallerCanInvoke } from "../api/caller-policy";
import { callOp, type OpDeps } from "../api/ops";
import { stepAwaitsReview, WAITING_FOR_REVIEW } from "../view-model/run-tree";
import { commandArgs } from "./accounts";
import type { Command, Result } from "./types";
import type { Ctx } from "../types";

const USAGE = "usage: pacer run start <workflow|auto> --brief <text> [--repo <path>] [--title <t>] [--priority urgent|normal|background] [--publish draft] | list [--status <s>] | show <id> | graph <id> [--version N] | submit-graph --file <path> --id <run> --step <step> | answer <id> <step> <answer> | stop <id> | retry-orchestrator <id> | sync <id> | publish <id> --title <t> --body-file <path> [--draft] | cleanup <id> [--delete-branch] [--yes] | auto <id> on|off | planner <id> <agent> | budget <id> [--turns N] [--messages N] | priority <id> urgent|normal|background | pause <id> | resume <id> | seen <id> | decide <id> <step> <choice> --reason <text> | decide --json '{\"id\",\"kind\":\"summary\",\"summary\":\"…\"}' | decide <id> --json '{\"kind\":\"summary\",\"summary\":\"…\"}' | choose <id> <step> <workflow> --reason <text> [--json]";
const STEP_USAGE = "usage: pacer step result --json '<JSON object>' | --file <path> | artifact <path> --label <text> | skip <id> <step> | retry <id> <step>";

async function call(ctx: Ctx, op: string, params: Record<string, unknown>, deps: OpDeps): Promise<unknown> {
  assertCallerCanInvoke(ctx, op, params);
  // Tests force in-process; a run grant otherwise selects HTTP only (API-5b).
  if (ctx.env.PACER_API === "inprocess") return callOp(ctx, op, params, deps);
  const client = await connectClient(ctx, { protocol: 3, opDeps: deps });
  try {
    return client.kind === "inprocess" ? await callOp(ctx, op, params, deps) : await client.call(op, params);
  } finally { client.close(); }
}

interface OpenQuestion { id: string; stepId: string; text: string; answerer: string; answerType: string }

/** What a live run waits on that can be acted on from here: open questions, and
 *  failed steps with no later attempt. */
function nextActions(
  run: RunLike, steps: StepLike[], questions: OpenQuestion[], plan?: { stepId: string },
): string[] {
  if (!["running", "waiting"].includes(run.status)) return [];
  const lines: string[] = [];
  for (const q of questions) {
    const who = q.answerer === "person" ? "waits on you" : "waits on the planner";
    const text = q.text.replace(/\s+/g, " ");
    lines.push(`question ${q.id}  step ${q.stepId}  ${who}`, `  ${text}`,
      `  answer: pacer answer ${q.id} ${q.answerType === "approve_revise" ? "approve|revise [--note <text>]" : '"<answer>"'}`,
      ...(plan?.stepId === q.stepId ? [`  full plan: pacer run show ${run.id} --json`] : []));
  }
  const failed = new Set(steps.filter(s => s.status === "failed"
    && !steps.some(later => later.stepId === s.stepId && later.branch === s.branch && later.attempt > s.attempt))
    .map(s => s.stepId));
  for (const step of failed) {
    lines.push(`failed step ${step}: pacer step retry ${run.id} ${step}  or  pacer step skip ${run.id} ${step}`);
  }
  return lines;
}

/** `--repo` defaults to the repository the CLI runs in (its git top-level). */
async function gitTopLevel(ctx: Ctx): Promise<string | undefined> {
  const r = await ctx.run(["git", "rev-parse", "--show-toplevel"], 10_000);
  const top = r.code === 0 ? r.stdout.trim() : "";
  return top || undefined;
}

interface RunLike {
  id: string;
  workflow: string;
  version: number;
  status: string;
  rev: number;
  reason?: string;
  priority?: string;
  pausedReason?: string;
}
interface StepLike { stepId: string; attempt: number; branch?: string; taskId?: string; status: string; error?: string; result?: unknown }

function runListLine(r: RunLike): string {
  const bits = [r.id, r.status, `${r.workflow}@${r.version}`, r.priority ?? "normal"];
  if (r.pausedReason) bits.push(`paused:${r.pausedReason}`);
  if (r.reason) bits.push(r.reason);
  return bits.join("  ");
}

function stepLabel(step: StepLike): string {
  const attempt = step.attempt > 1 ? `#${step.attempt}` : "";
  const branch = step.branch ? `/${step.branch}` : "";
  return `${step.stepId}${attempt}${branch}`;
}

function renderRun(run: RunLike, steps: StepLike[]): string {
  const lines = [`${run.id}  ${run.workflow}@${run.version}  ${run.status}${run.reason ? `  ${run.reason}` : ""}`];
  for (const step of steps) {
    const status = stepAwaitsReview(step) ? WAITING_FOR_REVIEW : step.status;
    lines.push([stepLabel(step), status, step.taskId ?? "-", ...(step.error ? [step.error] : [])].join("  "));
  }
  return lines.join("\n");
}

export async function runCmd(args: string[], ctx: Ctx, deps: OpDeps = {}): Promise<Result> {
  const [sub, ...rest] = args;
  const json = rest.includes("--json");
  try {
    if (sub === "start") {
      const { pos, flags } = commandArgs(rest, ["brief", "repo", "title", "priority", "publish"], ["json"]);
      if (pos.length !== 1 || !flags.brief) throw Error(USAGE);
      if (flags.publish !== undefined && flags.publish !== "draft") throw Error("--publish accepts only draft");
      const repo = String(flags.repo ?? await gitTopLevel(ctx) ?? "");
      if (!repo) throw Error("no --repo given and the current directory is not a git repository");
      if (flags.priority !== undefined && !["urgent", "normal", "background"].includes(String(flags.priority))) {
        throw Error(USAGE);
      }
      const params = {
        workflow: pos[0],
        repo,
        brief: String(flags.brief),
        ...(flags.title ? { title: String(flags.title) } : {}),
        ...(flags.priority ? { priority: String(flags.priority) } : {}),
        ...(flags.publish === "draft" ? { publish: "draft" as const } : {}),
      };
      const run = await call(ctx, "run.start", params, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  ${run.status}${run.priority && run.priority !== "normal" ? `  ${run.priority}` : ""}`, err: "" };
    }
    if (sub === "list") {
      const { pos, flags } = commandArgs(rest, ["status"], ["json"]);
      if (pos.length) throw Error(USAGE);
      const runs = await call(ctx, "run.list", flags.status ? { status: String(flags.status) } : {}, deps) as RunLike[];
      if (json) return { code: 0, out: JSON.stringify(runs, null, 2), err: "" };
      return { code: 0, out: runs.map(runListLine).join("\n"), err: "" };
    }
    if (sub === "show") {
      const { pos, flags } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as {
        run: RunLike; steps: StepLike[]; pendingApproval?: { stepId: string };
      };
      if (json) return { code: 0, out: JSON.stringify(got, null, 2), err: "" };
      const questions = await call(ctx, "question.list", { run: pos[0], status: "open" }, deps) as OpenQuestion[];
      return { code: 0, out: [renderRun(got.run, got.steps), ...nextActions(got.run, got.steps, questions, got.pendingApproval)].join("\n"), err: "" };
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
    if (sub === "retry-orchestrator") {
      const { pos } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const run = await call(ctx, "run.retry_orchestrator", { id: pos[0], expect_rev: got.run.rev }, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  planner will be retried`, err: "" };
    }
    if (sub === "sync") {
      const { pos, flags } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const result = await call(ctx, "run.sync_base", { id: pos[0], expect_rev: got.run.rev }, deps);
      const r = result as { ok: boolean; merge?: string; resolution_task?: string; run: RunLike };
      if (!r.ok) {
        if (flags.json || json) return { code: 1, out: JSON.stringify(result, null, 2), err: "" };
        return { code: 1, out: `${pos[0]}  sync conflict  ${r.resolution_task}`, err: "" };
      }
      if (flags.json || json) return { code: 0, out: JSON.stringify(result, null, 2), err: "" };
      return { code: 0, out: `${pos[0]}  synced`, err: "" };
    }
    if (sub === "publish") {
      const { pos, flags } = commandArgs(rest, ["title", "body-file"], ["json", "draft"]);
      if (pos.length !== 1 || !flags.title || !flags["body-file"]) throw Error(USAGE);
      const body = readFileSync(String(flags["body-file"]), "utf8");
      if (Buffer.byteLength(body, "utf8") > 60 * 1024) throw Error("body exceeds 60 KiB");
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const result = await call(ctx, "run.publish", {
        id: pos[0],
        draft: !!flags.draft,
        title: String(flags.title),
        body,
        expect_rev: got.run.rev,
      }, deps) as { pr_url: string; run: RunLike };
      if (flags.json || json) return { code: 0, out: JSON.stringify(result, null, 2), err: "" };
      return { code: 0, out: `${pos[0]}  ${result.pr_url}`, err: "" };
    }
    if (sub === "cleanup") {
      const { pos, flags } = commandArgs(rest, [], ["json", "delete-branch", "yes"]);
      if (pos.length !== 1) throw Error(USAGE);
      if (flags["delete-branch"] && !flags.yes) {
        throw Error("deleting the local run branch needs --yes");
      }
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const result = await call(ctx, "run.cleanup", {
        id: pos[0],
        delete_branch: !!flags["delete-branch"],
        expect_rev: got.run.rev,
      }, deps) as { run: RunLike; deleted_branch: string | null };
      if (flags.json || json) return { code: 0, out: JSON.stringify(result, null, 2), err: "" };
      return {
        code: 0,
        out: result.deleted_branch
          ? `${pos[0]}  cleaned; deleted ${result.deleted_branch}`
          : `${pos[0]}  cleaned`,
        err: "",
      };
    }
    if (sub === "auto") {
      const { pos } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 2 || !["on", "off"].includes(pos[1]!)) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const run = await call(ctx, "run.set_auto", {
        id: pos[0], auto: pos[1] === "on", expect_rev: got.run.rev,
      }, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  auto ${pos[1]}`, err: "" };
    }
    if (sub === "planner") {
      const { pos } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 2) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const run = await call(ctx, "run.set_planner", {
        id: pos[0], planner: pos[1], expect_rev: got.run.rev,
      }, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  planner ${pos[1]} (next turn)`, err: "" };
    }
    if (sub === "budget") {
      const { pos, flags } = commandArgs(rest, ["turns", "messages"], ["json"]);
      if (pos.length !== 1 || (flags.turns === undefined && flags.messages === undefined)) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const params: Record<string, unknown> = { id: pos[0], expect_rev: got.run.rev };
      if (flags.turns !== undefined) params.orchestrator_turns = Number(flags.turns);
      if (flags.messages !== undefined) params.message_turns = Number(flags.messages);
      const run = await call(ctx, "run.set_budget", params, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  budget updated`, err: "" };
    }
    if (sub === "priority") {
      const { pos } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 2 || !["urgent", "normal", "background"].includes(pos[1]!)) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const run = await call(ctx, "run.set_priority", {
        id: pos[0], priority: pos[1], expect_rev: got.run.rev,
      }, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  priority ${pos[1]}`, err: "" };
    }
    if (sub === "pause" || sub === "resume") {
      const { pos } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike };
      const run = await call(ctx, sub === "pause" ? "run.pause" : "run.resume", {
        id: pos[0], expect_rev: got.run.rev,
      }, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return {
        code: 0,
        out: `${run.id}  ${sub}${run.pausedReason ? `  ${run.pausedReason}` : ""}`,
        err: "",
      };
    }
    if (sub === "seen") {
      const { pos } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const run = await call(ctx, "run.seen", { id: pos[0] }, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  seen`, err: "" };
    }
    if (sub === "decide") {
      // Summary forms:
      //   decide --json '{"id","kind":"summary","summary":"…"}'
      //   decide <id> --json '{"kind":"summary","summary":"…"}'  (id from argv)
      // Bare --json (no value) remains an output flag for the step/choice form.
      const jsonIdx = rest.indexOf("--json");
      const jsonValue = jsonIdx >= 0 && rest[jsonIdx + 1] && !rest[jsonIdx + 1]!.startsWith("--")
        ? rest[jsonIdx + 1]
        : undefined;
      if (jsonValue !== undefined) {
        let payload: unknown;
        try { payload = JSON.parse(jsonValue); }
        catch { throw Error("--json needs one JSON object as its value"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw Error("--json must carry a JSON object");
        }
        const body = { ...(payload as Record<string, unknown>) };
        if (body.kind !== "summary") throw Error(USAGE);
        if (typeof body.id !== "string" || !body.id) {
          const positionalId = rest.find((a, i) => i !== jsonIdx && i !== jsonIdx + 1 && !a.startsWith("--"));
          if (positionalId) body.id = positionalId;
        }
        if (typeof body.id !== "string" || !body.id) throw Error(USAGE);
        const run = await call(ctx, "run.decide", body, deps) as RunLike & { summary?: string };
        return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      }
      const { pos, flags } = commandArgs(rest, ["reason"], ["json"]);
      if (pos.length < 3 || !flags.reason) throw Error(USAGE);
      const run = await call(ctx, "run.decide", {
        id: pos[0], step: pos[1], choice: pos.slice(2).join(" "), reason: String(flags.reason),
      }, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  decided ${pos[1]}`, err: "" };
    }
    if (sub === "choose") {
      const { pos, flags } = commandArgs(rest, ["reason"], ["json"]);
      if (pos.length !== 3 || !flags.reason) throw Error(USAGE);
      const child = await call(ctx, "run.choose", {
        id: pos[0], step: pos[1], workflow: pos[2], reason: String(flags.reason),
      }, deps) as RunLike;
      if (json) return { code: 0, out: JSON.stringify(child, null, 2), err: "" };
      return { code: 0, out: `${child.id}  chose ${pos[2]}`, err: "" };
    }
    if (sub === "graph") {
      const { pos, flags } = commandArgs(rest, ["version"], ["json"]);
      if (pos.length !== 1) throw Error(USAGE);
      const got = await call(ctx, "run.get", { id: pos[0] }, deps) as {
        run: RunLike;
        graphs?: { stepId: string; attempt: number; version: number; status: string; stepCount: number }[];
      };
      const graphs = got.graphs ?? [];
      const version = flags.version !== undefined ? Number(flags.version) : undefined;
      const filtered = version === undefined || !Number.isFinite(version)
        ? graphs
        : graphs.filter(g => g.version === version);
      if (json) return { code: 0, out: JSON.stringify(filtered, null, 2), err: "" };
      if (filtered.length === 0) return { code: 0, out: "(no graphs)", err: "" };
      return {
        code: 0,
        out: filtered.map(g =>
          `${got.run.id}  ${g.stepId}#${g.attempt}@v${g.version}  ${g.status}  ${g.stepCount} steps`,
        ).join("\n"),
        err: "",
      };
    }
    if (sub === "submit-graph") {
      const { pos, flags } = commandArgs(rest, ["file", "id", "step"], ["json"]);
      if (pos.length || !flags.file || !flags.id || !flags.step) throw Error(USAGE);
      const source = readFileSync(String(flags.file), "utf8");
      const result = await call(ctx, "run.submit_graph", {
        id: String(flags.id), step: String(flags.step), source,
      }, deps) as { ok: boolean; errors: unknown[]; version?: number };
      if (json) return { code: 0, out: JSON.stringify(result, null, 2), err: "" };
      if (!result.ok) {
        return { code: 2, out: "", err: `pacer: graph rejected (${JSON.stringify(result.errors)})` };
      }
      return { code: 0, out: `${flags.id}  graph v${result.version} submitted`, err: "" };
    }
    throw Error(USAGE);
  } catch (e) { return { code: 2, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** `pacer step result`: the executor-facing report of its workflow step's
 *  structured result. Runs in-process like `pacer ask`, because a delegated
 *  executor session holds no service client; identity is the op's
 *  `requireAskingExecutor`. `step skip|retry` are for the person and the run grant. */
export async function stepCmd(args: string[], ctx: Ctx, deps: OpDeps = {}): Promise<Result> {
  const [sub, ...rest] = args;
  try {
    if (sub === "skip" || sub === "retry") {
      const { pos, flags } = commandArgs(rest, [], ["json"]);
      if (pos.length !== 2) throw Error(STEP_USAGE);
      // The person's change carries the run's current rev; a run grant's does not.
      const rev = ctx.env.PACER_RUN_GRANT ? undefined
        : (await call(ctx, "run.get", { id: pos[0] }, deps) as { run: RunLike }).run.rev;
      const run = await call(ctx, sub === "skip" ? "step.skip" : "step.retry", {
        id: pos[0], step: pos[1], ...(rev !== undefined ? { expect_rev: rev } : {}),
      }, deps) as RunLike;
      if (flags.json) return { code: 0, out: JSON.stringify(run, null, 2), err: "" };
      return { code: 0, out: `${run.id}  ${sub} ${pos[1]}`, err: "" };
    }
    if (sub === "artifact") {
      const { pos, flags } = commandArgs(rest, ["label"], ["json"]);
      if (pos.length !== 1 || !flags.label) throw Error(STEP_USAGE);
      assertCallerCanInvoke(ctx, "step.artifact", { path: pos[0], label: String(flags.label) });
      const row = await callOp(ctx, "step.artifact", {
        path: resolve(pos[0]!), label: String(flags.label),
      }, deps);
      if (flags.json) return { code: 0, out: JSON.stringify(row, null, 2), err: "" };
      const art = row as { id: string; label: string };
      return { code: 0, out: `${art.id}  ${art.label}`, err: "" };
    }
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
  { name: "run", usage: "run start|list|show|graph|submit-graph|answer|stop|retry-orchestrator|sync|publish|cleanup|auto|planner|budget|priority|pause|resume|seen|decide|choose    start and follow runs", run: (args, ctx) => runCmd(args, ctx) },
  { name: "step", usage: "step result --json <object> | --file <path> | artifact <path> --label <text> | skip <id> <step> | retry <id> <step>    report or resolve a workflow step", run: (args, ctx) => stepCmd(args, ctx) },
];
