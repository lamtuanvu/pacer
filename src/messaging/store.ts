import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { CoreError } from "../core/errors";
import { taskDatabase } from "../tasks/store";
import type { Ctx } from "../types";
import type { Message, MsgKind, MsgStatus } from "./types";

interface Row { id: string; task_id: string | null; root_id: string; sender: string; recipient: string; kind: string; body: string; reply_to: string | null;
  request_id: string | null; status: string; created_at: number; delivered_at: number | null; read_at: number | null; turn_id: string | null; fingerprint?: string | null }

const ready = new WeakSet<Database>();
export function messagesDatabase(ctx: Ctx): Database {
  const db = taskDatabase(ctx);
  if (ready.has(db)) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS messages(
    id TEXT PRIMARY KEY, task_id TEXT NULL, root_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT NULL, request_id TEXT NULL, status TEXT NOT NULL,
    created_at REAL NOT NULL, delivered_at REAL NULL, read_at REAL NULL, turn_id TEXT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS messages_request ON messages(sender, request_id) WHERE request_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, status);
  CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
  CREATE INDEX IF NOT EXISTS messages_turn ON messages(turn_id);
  CREATE TABLE IF NOT EXISTS msg_turns(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, root_id TEXT NOT NULL, started_at REAL NOT NULL, ended_at REAL NULL, outcome TEXT NULL);
  CREATE INDEX IF NOT EXISTS msg_turns_root ON msg_turns(root_id);`);
  // Added after the first schema; existing databases gain the column in place.
  if (!db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().some(c => c.name === "fingerprint")) db.exec("ALTER TABLE messages ADD COLUMN fingerprint TEXT NULL");
  ready.add(db);
  return db;
}

/** What a request id stands for: the same recipient, kind and body. */
export const fingerprint = (to: string, kind: string, body: string) => createHash("sha256").update(JSON.stringify([to, kind, createHash("sha256").update(body).digest("hex")])).digest("hex");

export function byRequest(ctx: Ctx, from: string, requestId: string): (Message & { fingerprint: string | null }) | null {
  const r = messagesDatabase(ctx).query<Row, [string, string]>("SELECT * FROM messages WHERE sender=? AND request_id=?").get(from, requestId);
  return r ? { ...toMessage(r), fingerprint: r.fingerprint ?? null } : null;
}

const toMessage = (r: Row): Message => ({ id: r.id, taskId: r.task_id, rootId: r.root_id, from: r.sender, to: r.recipient, kind: r.kind as MsgKind, body: r.body,
  replyTo: r.reply_to, requestId: r.request_id, status: r.status as MsgStatus, createdAt: r.created_at, deliveredAt: r.delivered_at, readAt: r.read_at, turnId: r.turn_id });
// Sortable by creation: zero-padded milliseconds, then random.
const newId = (now: number) => `m-${Math.round(now * 1000).toString().padStart(14, "0")}-${randomBytes(4).toString("hex")}`;

export function getMessage(ctx: Ctx, id: string): Message | null {
  const r = messagesDatabase(ctx).query<Row, [string]>("SELECT * FROM messages WHERE id=?").get(id);
  return r ? toMessage(r) : null;
}

export function insertMessage(ctx: Ctx, m: Omit<Message, "id" | "status" | "createdAt" | "deliveredAt" | "readAt" | "turnId"> & { status?: "held" | "pending" }): { message: Message; duplicate: boolean } {
  const db = messagesDatabase(ctx);
  return db.transaction(() => {
    if (m.requestId) {
      const prior = db.query<Row, [string, string]>("SELECT * FROM messages WHERE sender=? AND request_id=?").get(m.from, m.requestId);
      if (prior) return { message: toMessage(prior), duplicate: true };
    }
    const id = newId(ctx.now);
    db.query("INSERT INTO messages(id,task_id,root_id,sender,recipient,kind,body,reply_to,request_id,status,created_at,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, m.taskId, m.rootId, m.from, m.to, m.kind, m.body, m.replyTo, m.requestId, m.status ?? "pending", ctx.now, fingerprint(m.to, m.kind, m.body));
    return { message: getMessage(ctx, id)!, duplicate: false };
  }).immediate();
}

export function thread(ctx: Ctx, taskId: string, o: { after?: string; limit?: number } = {}): Message[] {
  return messagesDatabase(ctx).query<Row, [string, string, number]>("SELECT * FROM messages WHERE task_id=? AND id>? ORDER BY id LIMIT ?")
    .all(taskId, o.after ?? "", Math.min(o.limit ?? 200, 1000)).map(toMessage);
}
export function inbox(ctx: Ctx, to: string, o: { unreadOnly?: boolean; limit?: number } = {}): Message[] {
  const where = o.unreadOnly ? "AND status IN ('pending','delivered')" : "AND status<>'held'";
  return messagesDatabase(ctx).query<Row, [string, number]>(`SELECT * FROM messages WHERE recipient=? ${where} ORDER BY id LIMIT ?`)
    .all(to, Math.min(o.limit ?? 200, 1000)).map(toMessage);
}
export function markRead(ctx: Ctx, to: string, ids: string[], at = ctx.now): number {
  const db = messagesDatabase(ctx);
  return db.transaction(() => ids.reduce((n, id) => n + db.query("UPDATE messages SET status='read', read_at=? WHERE id=? AND recipient=? AND status<>'read' AND status<>'held'").run(at, id, to).changes, 0)).immediate();
}
export function pendingFor(ctx: Ctx, to: string): Message[] {
  return messagesDatabase(ctx).query<Row, [string]>("SELECT * FROM messages WHERE recipient=? AND status='pending' ORDER BY id").all(to).map(toMessage);
}
/** Messages that still need a turn of this task: pending or held for it, or its questions nobody has read. */
export function awaitingTurn(ctx: Ctx, taskId: string): number {
  const to = `task:${taskId}`;
  return messagesDatabase(ctx).query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM messages WHERE (recipient=? AND status IN ('pending','held')) OR (sender=? AND kind='question' AND status IN ('pending','delivered'))")
    .get(to, to)!.n;
}
/** When the task's thread last changed, in seconds, or null when it has no messages. */
export function lastMessageAt(ctx: Ctx, taskId: string): number | null {
  return messagesDatabase(ctx).query<{ at: number | null }, [string]>("SELECT MAX(created_at) AS at FROM messages WHERE task_id=?").get(taskId)?.at ?? null;
}
export function claimPending(ctx: Ctx, to: string, turnId: string): Message[] {
  const db = messagesDatabase(ctx);
  return db.transaction(() => {
    db.query("UPDATE messages SET status='delivered', delivered_at=?, turn_id=? WHERE recipient=? AND status='pending'").run(ctx.now, turnId, to);
    return db.query<Row, [string, string]>("SELECT * FROM messages WHERE turn_id=? AND recipient=? ORDER BY id").all(turnId, to).map(toMessage);
  }).immediate();
}
export function claimedMessages(ctx: Ctx, turnId: string): Message[] {
  return messagesDatabase(ctx).query<Row, [string]>("SELECT * FROM messages WHERE turn_id=? ORDER BY id").all(turnId).map(toMessage);
}
export function releaseTurn(ctx: Ctx, turnId: string): number {
  return messagesDatabase(ctx).query("UPDATE messages SET status='pending', delivered_at=NULL, turn_id=NULL WHERE turn_id=? AND status='delivered'").run(turnId).changes;
}
export function confirmHeld(ctx: Ctx, id: string): Message {
  const changed = messagesDatabase(ctx).query("UPDATE messages SET status='pending' WHERE id=? AND status='held'").run(id).changes;
  if (!changed) throw new CoreError("conflict", "Message is not waiting for confirmation");
  return getMessage(ctx, id)!;
}
export function sentSince(ctx: Ctx, from: string, sinceS: number): Message[] {
  return messagesDatabase(ctx).query<Row, [string, number]>("SELECT * FROM messages WHERE sender=? AND created_at>=? ORDER BY id").all(from, sinceS).map(toMessage);
}
export function countSentSince(ctx: Ctx, from: string, sinceS: number): number {
  return messagesDatabase(ctx).query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM messages WHERE sender=? AND created_at>=?").get(from, sinceS)!.n;
}
/** A turn id is used once; reusing one would undercount the cap and keep a stale outcome. */
export function recordTurn(ctx: Ctx, t: { id: string; taskId: string; rootId: string; at: number }): void {
  const db = messagesDatabase(ctx);
  if (db.query("SELECT 1 FROM msg_turns WHERE id=?").get(t.id)) throw new CoreError("conflict", `Turn ${t.id} was already recorded`);
  db.query("INSERT INTO msg_turns(id,task_id,root_id,started_at) VALUES(?,?,?,?)").run(t.id, t.taskId, t.rootId, t.at);
}
export function turnsForTask(ctx: Ctx, taskId: string): number {
  return messagesDatabase(ctx).query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM msg_turns WHERE task_id=?").get(taskId)!.n;
}
export function endTurn(ctx: Ctx, id: string, outcome: string, at: number): void {
  messagesDatabase(ctx).query("UPDATE msg_turns SET ended_at=?, outcome=? WHERE id=? AND ended_at IS NULL").run(at, outcome, id);
}
export function lastTurnEndedAt(ctx: Ctx, taskId: string): number | null {
  return messagesDatabase(ctx).query<{ ended_at: number | null }, [string]>("SELECT ended_at FROM msg_turns WHERE task_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId)?.ended_at ?? null;
}
export function lastTurnOutcome(ctx: Ctx, taskId: string): string | null {
  return messagesDatabase(ctx).query<{ outcome: string | null }, [string]>("SELECT outcome FROM msg_turns WHERE task_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(taskId)?.outcome ?? null;
}
export function turnsForRoot(ctx: Ctx, rootId: string): number {
  return messagesDatabase(ctx).query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM msg_turns WHERE root_id=?").get(rootId)!.n;
}
export function unreadCounts(ctx: Ctx, to: string, taskIds: string[]): Map<string, { unread: number; question?: Message }> {
  const out = new Map<string, { unread: number; question?: Message }>();
  if (!taskIds.length) return out;
  const rows = messagesDatabase(ctx).query<Row, string[]>(`SELECT * FROM messages WHERE recipient=? AND status IN ('pending','delivered') AND kind<>'report' AND task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(to, ...taskIds);
  for (const r of rows) {
    const e = out.get(r.task_id!) ?? { unread: 0 };
    e.unread++;
    if (r.kind === "question") e.question = toMessage(r);
    out.set(r.task_id!, e);
  }
  return out;
}
