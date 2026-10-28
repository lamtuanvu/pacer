import { taskDatabase } from "../tasks/store";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";

export function dispatchDatabase(ctx: Ctx) {
  const db = taskDatabase(ctx);
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_nodes(task_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL, options TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS work_root ON work_nodes(root_id);
    CREATE TABLE IF NOT EXISTS work_grants(hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS enforcement_tokens(hash TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS enforcement_certificates(target TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, probed_at REAL NOT NULL, expires REAL NOT NULL, evidence TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, root_id TEXT NOT NULL, task_id TEXT NOT NULL, at REAL NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS work_event_root ON work_events(root_id,seq);
    CREATE TABLE IF NOT EXISTS work_decisions(task_id TEXT NOT NULL, attempt INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,attempt));
    CREATE TABLE IF NOT EXISTS work_reservations(task_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, runner TEXT NOT NULL, pools TEXT NOT NULL, estimate REAL NOT NULL, at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS work_observations(id TEXT PRIMARY KEY, at REAL NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_refresh(scope TEXT PRIMARY KEY, attempted REAL NOT NULL, retry_at REAL NOT NULL, failures INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_reviews(task_id TEXT NOT NULL, attempt INTEGER NOT NULL, at REAL NOT NULL, provenance TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,attempt));
    CREATE TABLE IF NOT EXISTS work_retry_requests(task_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY(task_id,key));
    CREATE TABLE IF NOT EXISTS work_waits(task_id TEXT NOT NULL, kind TEXT NOT NULL, started_at REAL, total_seconds REAL NOT NULL DEFAULT 0, refs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id,kind));
    CREATE TABLE IF NOT EXISTS work_dependency_waivers(task_id TEXT NOT NULL, dependency_id TEXT NOT NULL, reason TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(task_id,dependency_id));
    CREATE TABLE IF NOT EXISTS work_learning_exclusions(repo TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS work_learning_reset(repo TEXT PRIMARY KEY, at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS attempt_usage(task_id TEXT NOT NULL, attempt INTEGER NOT NULL, root_id TEXT NOT NULL, executor TEXT NOT NULL, account TEXT, model TEXT,
      extractor TEXT NOT NULL, ended_at REAL NOT NULL, kind TEXT, repo_key TEXT, outcome TEXT, ladder_rule TEXT,
      coverage TEXT NOT NULL CHECK(coverage IN ('measured','partial','unknown')), input INTEGER, cache_read INTEGER, cache_write INTEGER, output INTEGER, reasoning INTEGER, total INTEGER, turns INTEGER,
      source TEXT NOT NULL, self_reported INTEGER NOT NULL DEFAULT 0, captured_at REAL NOT NULL, note TEXT, PRIMARY KEY(task_id,attempt));
    CREATE INDEX IF NOT EXISTS attempt_usage_root ON attempt_usage(root_id);
    CREATE INDEX IF NOT EXISTS attempt_usage_ended ON attempt_usage(ended_at);
    CREATE TRIGGER IF NOT EXISTS work_task_changed AFTER UPDATE ON tasks WHEN EXISTS(SELECT 1 FROM work_nodes WHERE task_id=NEW.id) BEGIN
      INSERT INTO work_events(root_id,task_id,at,kind,data) SELECT root_id,NEW.id,NEW.updated_at,'task.changed',json_object('state',NEW.state,'rev',NEW.rev) FROM work_nodes WHERE task_id=NEW.id;
      DELETE FROM work_reservations WHERE task_id=NEW.id AND NEW.state NOT IN ('running');
      UPDATE work_grants SET revoked=1 WHERE task_id=NEW.id AND NEW.state NOT IN ('running');
      UPDATE enforcement_tokens SET revoked=1 WHERE task_id=NEW.id AND NEW.state NOT IN ('running');
      UPDATE work_waits SET total_seconds=total_seconds+CASE WHEN started_at IS NULL THEN 0 ELSE max(0,NEW.updated_at-started_at) END,started_at=NULL,refs=0 WHERE task_id=NEW.id AND NEW.state IN ('done','partial','failed','limit','stopped','needs_input');
    END;
    CREATE TRIGGER IF NOT EXISTS work_capacity_open AFTER UPDATE ON tasks WHEN EXISTS(SELECT 1 FROM work_nodes WHERE task_id=NEW.id) AND NEW.state='queued' AND json_extract(NEW.record,'$.queue.reason')='no_slot' BEGIN
      INSERT OR IGNORE INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(NEW.id,'capacity',NEW.updated_at,0,1);
      UPDATE work_waits SET started_at=COALESCE(started_at,NEW.updated_at),refs=1 WHERE task_id=NEW.id AND kind='capacity';
    END;
    CREATE TRIGGER IF NOT EXISTS work_queue_open AFTER UPDATE ON tasks WHEN EXISTS(SELECT 1 FROM work_nodes WHERE task_id=NEW.id) AND NEW.state='queued' BEGIN
      INSERT OR IGNORE INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(NEW.id,'queue',NEW.updated_at,0,1);
      UPDATE work_waits SET started_at=COALESCE(started_at,NEW.updated_at),refs=1 WHERE task_id=NEW.id AND kind='queue';
    END;
    CREATE TRIGGER IF NOT EXISTS work_queue_close AFTER UPDATE ON tasks WHEN EXISTS(SELECT 1 FROM work_nodes WHERE task_id=NEW.id) AND NEW.state!='queued' BEGIN
      UPDATE work_waits SET total_seconds=total_seconds+CASE WHEN started_at IS NULL THEN 0 ELSE max(0,NEW.updated_at-started_at) END,started_at=NULL,refs=0 WHERE task_id=NEW.id AND kind='queue';
    END;
    CREATE TRIGGER IF NOT EXISTS work_capacity_close AFTER UPDATE ON tasks WHEN EXISTS(SELECT 1 FROM work_nodes WHERE task_id=NEW.id) AND (NEW.state!='queued' OR COALESCE(json_extract(NEW.record,'$.queue.reason'),'')!='no_slot') BEGIN
      UPDATE work_waits SET total_seconds=total_seconds+CASE WHEN started_at IS NULL THEN 0 ELSE max(0,NEW.updated_at-started_at) END,started_at=NULL,refs=0 WHERE task_id=NEW.id AND kind='capacity';
    END;
  `);
  return db;
}
export function boundedJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 256 * 1024) throw new CoreError("too_large", "Work record exceeds 256 KiB");
  return text;
}
export function appendWorkEvent(ctx: Ctx, taskId: string, kind: string, data: unknown): void {
  const db = dispatchDatabase(ctx);
  db.query(`INSERT INTO work_events(root_id,task_id,at,kind,data) SELECT root_id,task_id,?,?,? FROM work_nodes WHERE task_id=?`).run(ctx.now, kind, boundedJson(data), taskId);
}
export function updateWorkDecision(ctx:Ctx,taskId:string,attempt:number,patch:Record<string,unknown>):void {
  const db=dispatchDatabase(ctx);
  const row=db.query<{data:string},[string,number]>("SELECT data FROM work_decisions WHERE task_id=? AND attempt=?").get(taskId,attempt);
  if(!row)throw new CoreError("conflict","Dispatch decision is missing for this attempt");
  db.query("UPDATE work_decisions SET data=? WHERE task_id=? AND attempt=?").run(boundedJson({...JSON.parse(row.data),...patch}),taskId,attempt);
}
