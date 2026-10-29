import { randomUUID } from "node:crypto";
import { taskDatabase } from "../tasks/store";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { type ActionCard, type AssistantLimits, type AssistantRetention, type AssistantScope, type AssistantSettings, type AssistantUsage, type Citation, type ConversationView, type TurnView, assistantLimitsSchema, retentionSchema } from "./types";

/** Assistant tables live in the service's private SQLite store (0600, WAL, secure_delete) under PACER_HOME. */
export function assistantDatabase(ctx: Ctx) {
  const db = taskDatabase(ctx);
  db.run("PRAGMA secure_delete = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_settings(id INTEGER PRIMARY KEY CHECK(id=1), runner TEXT, account TEXT, limits TEXT NOT NULL, retention TEXT NOT NULL, rev INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS assistant_conversations_updated ON assistant_conversations(updated_at);
    CREATE TABLE IF NOT EXISTS assistant_turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE, seq INTEGER NOT NULL, at REAL NOT NULL,
      question TEXT NOT NULL, answer TEXT, state TEXT NOT NULL, error TEXT, account TEXT, scope TEXT NOT NULL, tool_calls TEXT NOT NULL DEFAULT '[]', cards TEXT NOT NULL DEFAULT '[]', citations TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS assistant_turns_conversation ON assistant_turns(conversation_id, seq);
    CREATE TABLE IF NOT EXISTS assistant_usage(turn_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, at REAL NOT NULL, account TEXT, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER, cache_write INTEGER, coverage TEXT NOT NULL DEFAULT 'unknown' CHECK(coverage IN ('measured','partial','unknown')));
    CREATE INDEX IF NOT EXISTS assistant_usage_at ON assistant_usage(at);
  `);
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

const defaults = (): AssistantSettings => ({ runner: null, account: null, limits: assistantLimitsSchema.parse({}), retention: retentionSchema.parse({}), rev: 1 });

export function readSettings(ctx: Ctx): AssistantSettings {
  const row = assistantDatabase(ctx).query<{ runner: string | null; account: string | null; limits: string; retention: string; rev: number }, []>("SELECT runner,account,limits,retention,rev FROM assistant_settings WHERE id=1").get();
  if (!row) return defaults();
  return { runner: row.runner, account: row.account, limits: assistantLimitsSchema.parse(JSON.parse(row.limits)), retention: retentionSchema.parse(JSON.parse(row.retention)), rev: row.rev };
}

export function writeSettings(ctx: Ctx, input: { runner: string | null; account: string | null; limits?: Partial<AssistantLimits>; retention?: Partial<AssistantRetention>; expect_rev: number }): AssistantSettings {
  const db = assistantDatabase(ctx);
  return db.transaction(() => {
    const current = readSettings(ctx);
    if (current.rev !== input.expect_rev) throw new CoreError("conflict", "Assistant settings changed since you loaded them.", "Reload the settings and try again.", { rev: current.rev });
    const next: AssistantSettings = { runner: input.runner, account: input.account, limits: assistantLimitsSchema.parse({ ...current.limits, ...input.limits }), retention: retentionSchema.parse({ ...current.retention, ...input.retention }), rev: current.rev + 1 };
    db.query("INSERT INTO assistant_settings(id,runner,account,limits,retention,rev) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET runner=excluded.runner,account=excluded.account,limits=excluded.limits,retention=excluded.retention,rev=excluded.rev")
      .run(next.runner, next.account, JSON.stringify(next.limits), JSON.stringify(next.retention), next.rev);
    return next;
  }).immediate();
}

interface TurnRow { id: string; conversation_id: string; seq: number; at: number; question: string; answer: string | null; state: TurnView["state"]; error: string | null; account: string | null; scope: string; tool_calls: string; cards: string; citations: string }
const usageOf = (db: ReturnType<typeof assistantDatabase>, id: string): AssistantUsage | null => {
  const u = db.query<{ input: number; output: number; cache_read: number | null; cache_write: number | null; coverage: AssistantUsage["coverage"] }, [string]>("SELECT input,output,cache_read,cache_write,coverage FROM assistant_usage WHERE turn_id=?").get(id);
  return u ? { input: u.input, output: u.output, coverage: u.coverage, ...(u.cache_read !== null ? { cacheRead: u.cache_read } : {}), ...(u.cache_write !== null ? { cacheWrite: u.cache_write } : {}) } : null;
};
const toView = (db: ReturnType<typeof assistantDatabase>, r: TurnRow): TurnView => ({
  id: r.id, conversationId: r.conversation_id, at: r.at, question: r.question, answer: r.answer, state: r.state, error: r.error, account: r.account,
  usage: usageOf(db, r.id), cards: JSON.parse(r.cards) as ActionCard[], citations: JSON.parse(r.citations) as Citation[], scope: JSON.parse(r.scope) as AssistantScope,
});

export function startTurn(ctx: Ctx, input: { conversationId?: string; question: string; scope: AssistantScope; account: string | null }): { conversationId: string; turnId: string } {
  const db = assistantDatabase(ctx);
  return db.transaction(() => {
    let conversationId = input.conversationId;
    if (conversationId) {
      if (!db.query("SELECT 1 FROM assistant_conversations WHERE id=?").get(conversationId)) throw new CoreError("not_found", "Unknown conversation.");
    } else {
      conversationId = `conv-${randomUUID().slice(0, 12)}`;
      db.query("INSERT INTO assistant_conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)").run(conversationId, input.question.replace(/\s+/g, " ").slice(0, 80), ctx.now, ctx.now);
    }
    const seq = (db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM assistant_turns WHERE conversation_id=?").get(conversationId)?.n ?? 0) + 1;
    const turnId = `turn-${randomUUID().slice(0, 12)}`;
    db.query("INSERT INTO assistant_turns(id,conversation_id,seq,at,question,state,account,scope) VALUES(?,?,?,?,?,'running',?,?)").run(turnId, conversationId, seq, ctx.now, input.question, input.account, JSON.stringify(input.scope));
    db.query("INSERT INTO assistant_usage(turn_id,conversation_id,at,account) VALUES(?,?,?,?)").run(turnId, conversationId, ctx.now, input.account);
    db.query("UPDATE assistant_conversations SET updated_at=? WHERE id=?").run(ctx.now, conversationId);
    return { conversationId, turnId };
  }).immediate();
}

export function finishTurn(ctx: Ctx, turnId: string, input: { state: TurnView["state"]; answer?: string | null; error?: string | null; cards?: ActionCard[]; citations?: Citation[]; toolCalls?: unknown[]; usage?: AssistantUsage }): void {
  const db = assistantDatabase(ctx);
  db.transaction(() => {
    db.query("UPDATE assistant_turns SET state=?,answer=?,error=?,cards=?,citations=?,tool_calls=? WHERE id=?")
      .run(input.state, input.answer ?? null, input.error ?? null, JSON.stringify(input.cards ?? []), JSON.stringify(input.citations ?? []), JSON.stringify(input.toolCalls ?? []), turnId);
    if (input.usage) db.query("UPDATE assistant_usage SET input=?,output=?,cache_read=?,cache_write=?,coverage=? WHERE turn_id=?")
      .run(input.usage.input, input.usage.output, input.usage.cacheRead ?? null, input.usage.cacheWrite ?? null, input.usage.coverage, turnId);
    const conv = db.query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM assistant_turns WHERE id=?").get(turnId);
    if (conv) db.query("UPDATE assistant_conversations SET updated_at=? WHERE id=?").run(ctx.now, conv.conversation_id);
  }).immediate();
}

export function updateCard(ctx: Ctx, turnId: string, cardId: string, patch: Partial<Pick<ActionCard, "state" | "result" | "params" | "summary" | "title" | "editable">>): ActionCard {
  const db = assistantDatabase(ctx);
  return db.transaction(() => {
    const row = db.query<{ cards: string }, [string]>("SELECT cards FROM assistant_turns WHERE id=?").get(turnId);
    if (!row) throw new CoreError("not_found", "Unknown turn.");
    const cards = JSON.parse(row.cards) as ActionCard[];
    const at = cards.findIndex(c => c.id === cardId);
    if (at < 0) throw new CoreError("not_found", "Unknown action card.");
    cards[at] = { ...cards[at]!, ...patch };
    db.query("UPDATE assistant_turns SET cards=? WHERE id=?").run(JSON.stringify(cards), turnId);
    return cards[at]!;
  }).immediate();
}

export function getTurn(ctx: Ctx, turnId: string): TurnView | null {
  const db = assistantDatabase(ctx);
  const row = db.query<TurnRow, [string]>("SELECT * FROM assistant_turns WHERE id=?").get(turnId);
  return row ? toView(db, row) : null;
}

export function conversationTurns(ctx: Ctx, id: string): TurnView[] {
  const db = assistantDatabase(ctx);
  if (!db.query("SELECT 1 FROM assistant_conversations WHERE id=?").get(id)) throw new CoreError("not_found", "Unknown conversation.");
  return db.query<TurnRow, [string]>("SELECT * FROM assistant_turns WHERE conversation_id=? ORDER BY seq").all(id).map(r => toView(db, r));
}

export function listConversations(ctx: Ctx, o: { before?: number; limit?: number } = {}): ConversationView[] {
  const db = assistantDatabase(ctx);
  return db.query<{ id: string; title: string; updated_at: number; turns: number }, [number, number]>(
    "SELECT c.id,c.title,c.updated_at,(SELECT COUNT(*) FROM assistant_turns t WHERE t.conversation_id=c.id) AS turns FROM assistant_conversations c WHERE c.updated_at<? ORDER BY c.updated_at DESC LIMIT ?")
    .all(o.before ?? Number.MAX_SAFE_INTEGER, Math.min(o.limit ?? 30, 100)).map(r => ({ id: r.id, title: r.title, updatedAt: r.updated_at, turns: r.turns }));
}

/** The conversation window sent to the backend: the last 20 turns or 24 KiB, whichever is smaller. Earlier turns stay here. */
export function conversationWindow(ctx: Ctx, conversationId: string, excludeTurnId: string): { question: string; answer: string }[] {
  const db = assistantDatabase(ctx);
  const rows = db.query<{ question: string; answer: string | null }, [string, string]>("SELECT question,answer FROM assistant_turns WHERE conversation_id=? AND id!=? AND state='done' AND answer IS NOT NULL ORDER BY seq DESC LIMIT 20").all(conversationId, excludeTurnId);
  const out: { question: string; answer: string }[] = [];
  let bytes = 0;
  for (const r of rows) {
    bytes += Buffer.byteLength(r.question) + Buffer.byteLength(r.answer ?? "");
    if (bytes > 24 * 1024) break;
    out.unshift({ question: r.question, answer: r.answer ?? "" });
  }
  return out;
}

/** Deletes text only: usage rows stay so budget figures do not change. */
export function deleteConversations(ctx: Ctx, id?: string): { deleted: number } {
  const db = assistantDatabase(ctx);
  return db.transaction(() => {
    if (id) {
      if (!db.query("SELECT 1 FROM assistant_conversations WHERE id=?").get(id)) throw new CoreError("not_found", "Unknown conversation.");
      db.query("DELETE FROM assistant_turns WHERE conversation_id=?").run(id);
      return { deleted: db.query("DELETE FROM assistant_conversations WHERE id=?").run(id).changes };
    }
    db.query("DELETE FROM assistant_turns").run();
    return { deleted: db.query("DELETE FROM assistant_conversations").run().changes };
  }).immediate();
}
/** Deleted text can linger in WAL frames until a checkpoint; truncate so it does not. */
export function checkpoint(ctx: Ctx): void {
  try { assistantDatabase(ctx).run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* another connection holds the log; the next write retries */ }
}

export function enforceRetention(ctx: Ctx, retention: AssistantRetention = readSettings(ctx).retention): { deleted: number } {
  const db = assistantDatabase(ctx);
  return db.transaction(() => {
    const old = db.query<{ id: string }, [number]>("SELECT id FROM assistant_conversations WHERE updated_at<?").all(ctx.now - retention.days * 86400).map(r => r.id);
    const overflow = db.query<{ id: string }, [number]>("SELECT id FROM assistant_conversations ORDER BY updated_at DESC LIMIT -1 OFFSET ?").all(retention.conversations).map(r => r.id);
    const ids = [...new Set([...old, ...overflow])];
    for (const id of ids) { db.query("DELETE FROM assistant_turns WHERE conversation_id=?").run(id); db.query("DELETE FROM assistant_conversations WHERE id=?").run(id); }
    return { deleted: ids.length };
  }).immediate();
}

/** Turns started since local midnight, for the daily cap. */
export function turnsToday(ctx: Ctx): number {
  const midnight = new Date(ctx.now * 1000); midnight.setHours(0, 0, 0, 0);
  return assistantDatabase(ctx).query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM assistant_usage WHERE at>=?").get(midnight.getTime() / 1000)?.n ?? 0;
}

export function usageToday(ctx: Ctx): { turns: number; input: number; output: number } {
  const midnight = new Date(ctx.now * 1000); midnight.setHours(0, 0, 0, 0);
  const r = assistantDatabase(ctx).query<{ n: number; i: number | null; o: number | null }, [number]>("SELECT COUNT(*) AS n,SUM(input) AS i,SUM(output) AS o FROM assistant_usage WHERE at>=?").get(midnight.getTime() / 1000);
  return { turns: r?.n ?? 0, input: r?.i ?? 0, output: r?.o ?? 0 };
}

/** A turn left `running` by a restart cannot finish. Settle it so History never shows an answer that will not come. */
export function settleInterruptedTurns(ctx: Ctx, activeTurnId: string | null, olderThanS = 300): number {
  return assistantDatabase(ctx).query("UPDATE assistant_turns SET state='error',error='The service restarted before this answer finished.' WHERE state='running' AND at<? AND id IS NOT ?")
    .run(ctx.now - olderThanS, activeTurnId).changes;
}
