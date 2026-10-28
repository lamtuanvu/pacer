import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { dispatchDatabase } from "../dispatch/store";
import { listTasksWhere } from "../tasks/store";
import type { Attempt, AttemptTokens, TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { agentOf, extractAttemptTokens, readGzipLogText, readLogText, unknownTokens, USAGE_FILE } from "./extract";

/** One row per attempt. Numbers stay NULL when unreported: unknown is never stored as zero. */
export interface AttemptUsageRow {
  task_id: string; attempt: number; root_id: string; executor: string; account: string | null; model: string | null;
  extractor: string; ended_at: number; kind: string | null; repo_key: string | null; outcome: string | null; ladder_rule: string | null;
  coverage: AttemptTokens["coverage"]; input: number | null; cache_read: number | null; cache_write: number | null; output: number | null;
  reasoning: number | null; total: number | null; turns: number | null; source: AttemptTokens["source"]; self_reported: number;
  captured_at: number; note: string | null;
}

const RANK = { unknown: 0, partial: 1, measured: 2 } as const;

/** The attempt's outcome for the index: the planner's verdict when there is one, else how the task ended. */
function outcomeOf(task: TaskRecord): string {
  return task.review ? (task.review.accepted ? "accepted" : "rejected") : task.state;
}

/**
 * Idempotent upsert keyed by (task, attempt). A re-extraction replaces a row only when its coverage is
 * at least as good, so a newer extractor can improve a row but never degrade a measured one.
 * Call it inside the transaction that writes the attempt.
 */
export function recordAttemptUsage(ctx: Ctx, task: TaskRecord, index: number, tokens: AttemptTokens, account?: string | null): void {
  const attempt = task.attempts[index - 1];
  if (!attempt) return;
  const db = dispatchDatabase(ctx);
  const root = db.query<{ root_id: string }, [string]>("SELECT root_id FROM work_nodes WHERE task_id=?").get(task.id)?.root_id ?? task.id;
  db.query(`INSERT INTO attempt_usage(task_id,attempt,root_id,executor,account,model,extractor,ended_at,kind,repo_key,outcome,ladder_rule,
      coverage,input,cache_read,cache_write,output,reasoning,total,turns,source,self_reported,captured_at,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id,attempt) DO UPDATE SET root_id=excluded.root_id,executor=excluded.executor,account=COALESCE(excluded.account,attempt_usage.account),
      model=excluded.model,ended_at=excluded.ended_at,kind=excluded.kind,repo_key=excluded.repo_key,outcome=excluded.outcome,ladder_rule=excluded.ladder_rule,
      extractor=excluded.extractor,coverage=excluded.coverage,input=excluded.input,cache_read=excluded.cache_read,cache_write=excluded.cache_write,
      output=excluded.output,reasoning=excluded.reasoning,total=excluded.total,turns=excluded.turns,source=excluded.source,
      self_reported=excluded.self_reported,captured_at=excluded.captured_at,note=excluded.note
    WHERE CASE attempt_usage.coverage WHEN 'measured' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END <= CASE excluded.coverage WHEN 'measured' THEN 2 WHEN 'partial' THEN 1 ELSE 0 END`)
    .run(task.id, index, root, attempt.executor, account ?? attempt.usageAtStart?.account ?? null, attempt.actualModel ?? attempt.model ?? null, tokens.extractor,
      attempt.endedAt, attempt.routing?.kind ?? task.kind ?? null, task.repo?.key ?? null, outcomeOf(task), attempt.routing?.rule ?? null,
      tokens.coverage, tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output, tokens.reasoning, tokens.total, tokens.turns,
      tokens.source, tokens.selfReported ? 1 : 0, tokens.capturedAt, tokens.note ?? null);
}

/** Tokens for an attempt: the task record's own value, else the index row (backfilled history). */
export function attemptTokensFromRow(row: AttemptUsageRow): AttemptTokens {
  return {
    coverage: row.coverage, input: row.input, cacheRead: row.cache_read, cacheWrite: row.cache_write, output: row.output,
    reasoning: row.reasoning, total: row.total, turns: row.turns, source: row.source, selfReported: row.self_reported === 1,
    extractor: row.extractor, capturedAt: row.captured_at, ...(row.note ? { note: row.note } : {}),
  };
}
export function readAttemptUsage(ctx: Ctx, taskId: string): Map<number, AttemptTokens> {
  const rows = dispatchDatabase(ctx).query<AttemptUsageRow, [string]>("SELECT * FROM attempt_usage WHERE task_id=? ORDER BY attempt").all(taskId);
  return new Map(rows.map(r => [r.attempt, attemptTokensFromRow(r)]));
}

/** The text an extractor reads for an attempt: Claude's reduced usage file when pacer wrote one, else the log. */
export function attemptUsageText(ctx: Ctx, taskId: string, index: number, executor: string, log: string): string | null {
  if (agentOf(executor) === "claude-code") {
    const usage = readLogText(join(ctx.pacerHome, "runs", taskId, String(index), USAGE_FILE));
    // The log holds the result text, which the model can write; only pacer's reduced file counts.
    return usage ? usage.text : null;
  }
  return log ? readLogText(log)?.text ?? null : null;
}
/** Backfill reads paths from task records, which are data: stay inside pacer home. */
const underHome = (ctx: Ctx, path: string) => { const root = resolve(ctx.pacerHome) + sep; return resolve(path).startsWith(root); };
function backfillLog(ctx: Ctx, task: TaskRecord, attempt: Attempt, index: number): { text: string; truncated: boolean } | null {
  if (agentOf(attempt.executor) === "claude-code") {
    const usage = readLogText(join(ctx.pacerHome, "runs", task.id, String(index), USAGE_FILE));
    return usage;
  }
  if (!attempt.log || !underHome(ctx, attempt.log)) return null;
  if (existsSync(attempt.log)) return readLogText(attempt.log);
  if (task.archived && task.archivePath && underHome(ctx, task.archivePath)) return readGzipLogText(join(task.archivePath, `${basename(attempt.log)}.gz`));
  return null;
}

export interface BackfillResult { tasks: number; attempts: number; written: number }

/**
 * Fill `attempt_usage` for history. Reads logs and task records, writes only the index table: task
 * files, task rows and logs are never touched. Safe to run repeatedly; rows that already exist at
 * the same or better coverage are left as they are.
 */
export async function backfillAttemptUsage(ctx: Ctx): Promise<BackfillResult> {
  const db = dispatchDatabase(ctx), result: BackfillResult = { tasks: 0, attempts: 0, written: 0 };
  const exists = db.query<{ n: number }, [string, number]>("SELECT count(*) AS n FROM attempt_usage WHERE task_id=? AND attempt=?");
  let before: string | undefined;
  for (;;) {
    const page = listTasksWhere(ctx, { all: true, before, limit: 50 });
    if (!page.length) break;
    before = page[page.length - 1]!.id;
    await new Promise(resolve => setImmediate(resolve)); // let the service answer requests between pages
    for (const task of page) {
      await new Promise(resolve => setImmediate(resolve));
      result.tasks++;
      task.attempts.forEach((attempt, i) => {
        result.attempts++;
        const index = i + 1;
        if (exists.get(task.id, index)!.n) return;
        let tokens = attempt.tokens;
        if (!tokens) {
          const log = backfillLog(ctx, task, attempt, index);
          tokens = log === null
            ? unknownTokens("backfill@1", ctx, task.archived ? "archived log is not readable" : "no readable usage record for this attempt")
            : extractAttemptTokens({ executor: attempt.executor, log: log.text, truncated: log.truncated, exitCode: attempt.exitCode, timedOut: attempt.timedOut, now: ctx.now });
        }
        db.transaction(() => recordAttemptUsage(ctx, task, index, tokens!)).immediate();
        result.written++;
      });
    }
  }
  return result;
}
