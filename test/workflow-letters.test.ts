import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { taskDatabase } from "../src/tasks/store";
import { letterAt, nextLetter, resolveRunLetters } from "../src/workflow/letters";
import { composeSnapshotRuns } from "../src/api/read-model/runs";
import { insertRun, liveRuns, resetWorkflowSchemaReadyForTests, workflowDatabase } from "../src/workflow/store";

test("letterAt covers A–Z then AA, AB", () => {
  expect(letterAt(0)).toBe("A");
  expect(letterAt(25)).toBe("Z");
  expect(letterAt(26)).toBe("AA");
  expect(letterAt(27)).toBe("AB");
  expect(letterAt(51)).toBe("AZ");
  expect(letterAt(52)).toBe("BA");
});

test("nextLetter skips used letters including past Z", () => {
  const used = Array.from({ length: 26 }, (_, i) => letterAt(i));
  expect(nextLetter(used)).toBe("AA");
  expect(nextLetter([...used, "AA"])).toBe("AB");
});

test("resolveRunLetters keeps stored letters and fills gaps deterministically", () => {
  const map = resolveRunLetters([
    { id: "r2", createdAt: 2, letter: null },
    { id: "r1", createdAt: 1, letter: "C" },
    { id: "r3", createdAt: 3 },
  ]);
  expect(map.get("r1")).toBe("C");
  expect(map.get("r2")).toBe("A");
  expect(map.get("r3")).toBe("B");
});

test("pre-Phase-6 letterless live run: TS resolves in memory; read paths never write", () => {
  const ctx = fakeCtx();
  const run = insertRun(ctx, { workflow: "t/letter", version: 1, repo: tmpDir(), brief: "b" });
  // Simulate a pre-Phase-6 row (letter cleared after insert).
  workflowDatabase(ctx).query("UPDATE workflow_runs SET letter = NULL WHERE id = ?").run(run.id);
  const live = liveRuns(ctx);
  expect(live.find(r => r.id === run.id)?.letter).toBeUndefined();
  const snap = composeSnapshotRuns(ctx);
  expect(snap.find(r => r.id === run.id)?.letter).toBe("A");
  // Row still letterless on disk after read paths.
  const row = workflowDatabase(ctx).query<{ letter: string | null }, [string]>(
    "SELECT letter FROM workflow_runs WHERE id = ?",
  ).get(run.id);
  expect(row?.letter).toBeNull();
});

test("schema backfill skips letters held by terminal rows", () => {
  const ctx = fakeCtx();
  // Real workflowDatabase schema init: pre-letter tables, terminal holds A, live letterless.
  const dbPath = join(ctx.pacerHome, "state/tasks.db");
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE workflow_runs(
      id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT,
      status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL
    );
    INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at)
    VALUES ('run_term', 't/letter', 1, '/r', 'done', 'done', 'done', NULL, '{}', 1, 1, 1);
    INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at)
    VALUES ('run_live', 't/letter', 1, '/r', 'live', 'live', 'running', NULL, '{}', 1, 2, 2);
  `);
  raw.exec("ALTER TABLE workflow_runs ADD COLUMN letter TEXT");
  raw.exec("UPDATE workflow_runs SET letter = 'A' WHERE id = 'run_term'");
  raw.close();
  resetWorkflowSchemaReadyForTests();
  taskDatabase(ctx);
  workflowDatabase(ctx);
  const live = workflowDatabase(ctx).query<{ letter: string | null }, [string]>(
    "SELECT letter FROM workflow_runs WHERE id = ?",
  ).get("run_live");
  const term = workflowDatabase(ctx).query<{ letter: string | null }, [string]>(
    "SELECT letter FROM workflow_runs WHERE id = ?",
  ).get("run_term");
  expect(term?.letter).toBe("A");
  expect(live?.letter).toBe("B");
});

test("attention and snapshot letters agree for letterless rows", async () => {
  const { deriveWorkflowAttention, attentionLetterForRun } = await import("../src/workflow/attention");
  const { insertQuestion } = await import("../src/workflow/store");
  const ctx = fakeCtx();
  const a = insertRun(ctx, { workflow: "t/letter", version: 1, repo: tmpDir(), brief: "a" });
  const b = insertRun(ctx, { workflow: "t/letter", version: 1, repo: tmpDir(), brief: "b" });
  workflowDatabase(ctx).query("UPDATE workflow_runs SET letter = NULL WHERE id IN (?, ?)").run(a.id, b.id);
  const live = liveRuns(ctx);
  const letters = resolveRunLetters(live);
  const snap = composeSnapshotRuns(ctx);
  for (const run of live) {
    const expected = snap.find(s => s.id === run.id)?.letter;
    expect(expected).toBeTruthy();
    expect(attentionLetterForRun(run, letters)).toBe(expected!);
  }
  insertQuestion(ctx, {
    runId: a.id, stepId: "done", attempt: 1, askerKind: "orchestrator",
    text: "?", answerType: "yes_no", blocks: "nothing", answerer: "person",
  });
  const items = deriveWorkflowAttention(ctx);
  const qItem = items.find(i => i.kind === "question" && i.run?.id === a.id);
  expect(qItem?.run?.letter).toBe(snap.find(s => s.id === a.id)?.letter);
});
