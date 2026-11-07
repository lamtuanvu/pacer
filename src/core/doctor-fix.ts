import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendActivity } from "../activity/log";
import { loadStrategy } from "../config/strategy";
import { parseRunnerId } from "../config/runner-id";
import { redactEndpointMessage } from "../endpoints/state";
import { binaryFor } from "../engine/status";
import { readJson, writeJsonAtomic } from "../fsutil";
import { AGENT_BINS, type AgentId } from "../install/detection";
import type { Check } from "../install/doctor";
import { readTask, updateTask } from "../tasks/store";
import type { Ctx } from "../types";
import { CoreError } from "./errors";
import { publishConfigChange } from "./events";

export interface DoctorReport { checkedAt: number; checks: Check[]; planner?: string; repairAvailable?: boolean }
export type DiagnosticFixScope = "fix" | "investigate";
export type RunDoctor = (ctx: Ctx) => Promise<DoctorReport>;

/** A stored result older than this is rerun before it becomes a brief. */
const LATEST_MAX_AGE_S = 3600;
const REPORT_LINE_MAX = 500;

const latestPath = (ctx: Ctx) => join(ctx.pacerHome, "diagnostics", "doctor-latest.json");

/** Keep the latest doctor result so a fix brief is built from the server's own record. */
export function saveDoctorReport(ctx: Ctx, report: DoctorReport): void {
  if (!ctx.readOnly) writeJsonAtomic(latestPath(ctx), report);
}

export function readDoctorReport(ctx: Ctx): DoctorReport | null {
  const report = readJson<DoctorReport>(latestPath(ctx));
  return report && typeof report.checkedAt === "number" && Array.isArray(report.checks) ? report : null;
}

async function currentCheck(ctx: Ctx, name: string, rerun: RunDoctor): Promise<{ report: DoctorReport; check: Check | undefined }> {
  const stored = readDoctorReport(ctx);
  const age = stored ? ctx.now - stored.checkedAt : -1;
  const fresh = stored && age >= 0 && age < LATEST_MAX_AGE_S && stored.checks.some(check => check.name === name) ? stored : null;
  const report = fresh ?? await rerun(ctx);
  return { report, check: report.checks.find(check => check.name === name) };
}

function redact(ctx: Ctx, text: string): string {
  const safe = redactEndpointMessage(text).trim();
  return ctx.home ? safe.replaceAll(ctx.home, "~") : safe;
}

/** The agent a check is about, when it names one. */
function checkAgent(ctx: Ctx, name: string): { id: string; agent: string; bin: string } | null {
  if (name.startsWith("Claude ") || name === "Legacy guard") return { id: "claude-code", agent: "claude-code", bin: "claude" };
  const match = /^(?:Binary|CLI|Login|Usage|Install|Skill|Integration freshness|Planner check) (.+)$/.exec(name);
  const id = match?.[1];
  const agent = id ? parseRunnerId(id)?.agent : undefined;
  if (!id || !agent) return null;
  let provider;
  try { provider = loadStrategy(ctx).providers[id]; } catch { /* The brief still names the agent's default command. */ }
  const bin = provider ? binaryFor(provider) : AGENT_BINS[agent as AgentId]?.[0] ?? agent;
  return { id, agent, bin };
}

async function agentFacts(ctx: Ctx, bin: string): Promise<{ path: string | null; version: string | null }> {
  const path = ctx.which(bin);
  if (!path) return { path: null, version: null };
  try {
    const result = await ctx.run([bin, "--version"], 5000);
    const line = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0]?.slice(0, 200);
    return { path, version: result.code === 0 && line ? line : null };
  } catch { return { path, version: null }; }
}

function checkCommand(check: Check, bin: string | undefined): string {
  if (bin && check.name.startsWith("CLI ")) return `${bin} --help`;
  if (bin && check.name.startsWith("Binary ")) return `command -v ${bin}`;
  return "pacer doctor --json";
}

const SCOPE: Record<DiagnosticFixScope, string> = {
  fix: "Repair only the failing tool or integration named in this brief. Ask before changing anything outside it. Do not edit pacer's own state under its home folder, and never print, copy or commit credentials. When you finish, run `pacer doctor` and report whether the check passes.",
  investigate: "Change nothing. Investigate the cause, then propose a fix with the exact commands or edits, without applying them.",
};

/** The brief comes only from the stored check and report; no client text enters it. */
export async function diagnosticBrief(ctx: Ctx, check: Check, report: DoctorReport, scope: DiagnosticFixScope) {
  const agent = checkAgent(ctx, check.name);
  const facts = agent ? await agentFacts(ctx, agent.bin) : null;
  const lines = report.checks.map(item =>
    redact(ctx, `[${item.level}] ${item.name}: ${item.detail}${item.fix ? ` (fix: ${item.fix})` : ""}`).slice(0, REPORT_LINE_MAX));
  const context = [
    "## Failing check", "",
    `- Check: ${check.name}`,
    `- Result: ${check.level}${check.evidence ? ` (${check.evidence})` : ""}`,
    `- Detail: ${redact(ctx, check.detail)}`,
    ...(check.fix ? [`- Reported recovery instructions: ${redact(ctx, check.fix)}`] : []),
    `- Command the check runs: \`${checkCommand(check, agent?.bin)}\``,
    ...(agent ? ["", "## Agent", "",
      `- Agent: ${agent.agent} (${agent.id})`,
      `- Command: ${agent.bin}`,
      `- Install path: ${facts?.path ? redact(ctx, facts.path) : "not found on PATH"}`,
      `- Version: ${facts?.version ? redact(ctx, facts.version) : "unknown"}`] : []),
    "", "## Diagnostics report (redacted)", "",
    "```", ...lines, "```",
  ].join("\n");
  const verb = scope === "fix" ? "Fix" : "Investigate";
  return {
    title: `${verb} check: ${check.name}`.slice(0, 60).trim(),
    goal: scope === "fix" ? `Make the pacer diagnostics check "${check.name}" pass.`
      : `Find why the pacer diagnostics check "${check.name}" does not pass and propose a fix.`,
    context,
    constraints: SCOPE[scope],
  };
}

async function scratchRepo(ctx: Ctx, context: string): Promise<string> {
  const root = join(ctx.pacerHome, "diagnostics", "fix");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const repo = mkdtempSync(join(root, `fix-${Math.floor(ctx.now * 1000)}-`));
  writeFileSync(join(repo, "DIAGNOSTICS.md"), `# Diagnostics fix\n\n${context}\n`, { mode: 0o600 });
  for (const args of [["init", "-q", "-b", "main"], ["add", "DIAGNOSTICS.md"], ["-c", "user.name=pacer", "-c", "user.email=pacer@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Record the failing diagnostics check"]]) {
    const result = await ctx.run(["git", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], 10_000);
    if (result.code !== 0) throw new CoreError("unavailable", "Could not create the diagnostics fix workspace", result.stderr.trim() || undefined);
  }
  return repo;
}

export interface DiagnosticFixDeps {
  doctor: RunDoctor;
  /** The `task.delegate` operation, so routing, pacing and review apply as usual. */
  delegate: (params: Record<string, unknown>) => Promise<unknown>;
}

/** Start an ordinary pacer task for a failing check, recording which check it fixes. */
export async function delegateDiagnosticFix(ctx: Ctx, params: { check: string; scope: DiagnosticFixScope }, deps: DiagnosticFixDeps) {
  const { report, check } = await currentCheck(ctx, params.check, deps.doctor);
  if (!check) throw new CoreError("not_found", "No diagnostics check has that name", "Run doctor.run and choose a check from its result.");
  if (check.level !== "warn" && check.level !== "fail") throw new CoreError("conflict", "This check is not failing", "Run doctor.run again to refresh the result.");
  if (check.remedy?.kind === "internal") throw new CoreError("not_allowed", "pacer could not run this check itself", "Restart the pacer service, then run doctor.run again.");
  const brief = await diagnosticBrief(ctx, check, report, params.scope);
  const repo = await scratchRepo(ctx, brief.context);
  const summary = await deps.delegate({ ...brief, repo, kind: "debug", worktree: "current" }) as { task_id: string };
  const task = readTask(ctx, summary.task_id) ? updateTask(ctx, summary.task_id, t => { t.diagnosticCheck = check.name; }) : null;
  return { task: summary, check: check.name, scope: params.scope, ...(task ? { rev: task.rev } : {}) };
}

const ONLY_WHILE_FAILING = new Set(["Executor", "Installs", "Legacy guard"]);

/** After an accepted fix, rerun the doctor and record whether the check now passes. */
export async function recheckDiagnostic(ctx: Ctx, taskId: string, rerun: RunDoctor): Promise<Check | null> {
  const task = readTask(ctx, taskId);
  const name = task?.diagnosticCheck;
  if (!name || task.review?.accepted !== true) return null;
  const report = await rerun(ctx);
  const check = report.checks.find(item => item.name === name);
  // A check missing from the rerun did not pass: its prerequisite (strategy, binary, install) may be what broke.
  // These few are reported only while something is wrong, so their absence after a valid rerun means fixed.
  const resolved = !check && ONLY_WHILE_FAILING.has(name) && report.checks.some(c => c.name === "Strategy" && c.level === "ok");
  const passed = resolved || check?.level === "ok" || check?.level === "info";
  const detail = check ? redact(ctx, check.detail)
    : resolved ? "The check no longer reports a problem." : "The check did not run. Run pacer doctor to see what it depends on.";
  updateTask(ctx, taskId, t => { t.diagnosticRecheck = { at: ctx.now, passed, level: check?.level ?? null, detail }; });
  appendActivity(ctx, { kind: "config", level: passed ? "info" : "warn",
    text: passed ? `Fixed and rechecked · ${name}` : `Still failing after fix · ${name}: ${detail}`, taskId });
  await publishConfigChange(ctx, "diagnostics");
  return check ?? null;
}
