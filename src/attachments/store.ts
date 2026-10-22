import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  writeSync,
  renameSync,
  unlinkSync,
  constants,
} from "node:fs";
import { basename, join } from "node:path";
import { taskDatabase } from "../tasks/store";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { AttachmentMetadata, AttachmentRef } from "./types";

const FILE_LIMIT = 25 * 1024 * 1024,
  SESSION_LIMIT = 100 * 1024 * 1024;
interface Row extends AttachmentMetadata {
  draft: string;
  batch: string;
  task: string | null;
  state: string;
}
function database(ctx: Ctx) {
  const db = taskDatabase(ctx);
  db.run(`CREATE TABLE IF NOT EXISTS attachment_drafts (id TEXT PRIMARY KEY, created REAL NOT NULL, task TEXT);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, draft TEXT NOT NULL, batch TEXT NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, task TEXT, state TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attachments_draft ON attachments(draft);`);
  return db;
}
function root(ctx: Ctx): string {
  const path = join(ctx.pacerHome, "attachments");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new CoreError(
      "not_allowed",
      "Attachment storage is not a private directory",
    );
  return path;
}
function requireDraft(ctx: Ctx, id: string) {
  const draft = database(ctx)
    .query<
      { id: string; created: number; task: string | null },
      [string]
    >("SELECT * FROM attachment_drafts WHERE id=?")
    .get(id);
  if (!draft || (!draft.task && draft.created <= ctx.now - 86400))
    throw new CoreError(
      "not_found",
      "Attachment draft expired or does not exist",
    );
  return draft;
}
export function attachmentDirectory(ctx: Ctx, draftId: string): string {
  requireDraft(ctx, draftId);
  const path = join(root(ctx), draftId);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new CoreError("not_allowed", "Attachment directory is invalid");
  return path;
}
export function createDraft(ctx: Ctx): { id: string } {
  const id = randomUUID();
  database(ctx)
    .query("INSERT INTO attachment_drafts(id,created) VALUES (?,?)")
    .run(id, ctx.now);
  return { id };
}
const metadata = (row: Row): AttachmentMetadata => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  size: row.size,
});
export function listAttachments(
  ctx: Ctx,
  draftId: string,
): AttachmentMetadata[] {
  requireDraft(ctx, draftId);
  return database(ctx)
    .query<
      Row,
      [string]
    >("SELECT * FROM attachments WHERE draft=? AND state='ready'")
    .all(draftId)
    .map(metadata);
}
export async function storeAttachment(
  ctx: Ctx,
  input: {
    draftId: string;
    batchId: string;
    name: string;
    mime: string;
    body: ReadableStream<Uint8Array>;
  },
): Promise<AttachmentMetadata> {
  requireDraft(ctx, input.draftId);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.batchId) ||
    input.name.length > 4096 ||
    input.mime.length > 128
  )
    throw new CoreError("invalid_input", "Invalid attachment metadata");
  const name =
    basename(input.name.replaceAll("\\", "/"))
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 255) || "attachment";
  const db = database(ctx),
    id = randomUUID();
  const path = join(attachmentDirectory(ctx, input.draftId), id),
    temp = `${path}.upload`;
  db.transaction(() => {
    const count = db
      .query<
        { n: number },
        [string, string]
      >("SELECT COUNT(*) AS n FROM attachments WHERE draft=? AND batch=?")
      .get(input.draftId, input.batchId)!.n;
    if (count >= 20)
      throw new CoreError("too_large", "A batch can contain at most 20 files");
    db.query(
      "INSERT INTO attachments(id,draft,batch,name,mime,state) VALUES (?,?,?,?,?,'uploading')",
    ).run(id, input.draftId, input.batchId, name, input.mime);
  }).immediate();
  let fd: number | undefined,
    size = 0;
  const reader = input.body.getReader();
  try {
    fd = openSync(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > FILE_LIMIT)
        throw new CoreError("too_large", "Attachment exceeds 25 MiB");
      db.transaction(() => {
        requireDraft(ctx, input.draftId);
        const sum = db
          .query<
            { bytes: number },
            [string]
          >("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE draft=?")
          .get(input.draftId)!.bytes;
        if (sum + chunk.value.byteLength > SESSION_LIMIT)
          throw new CoreError(
            "too_large",
            "Session attachments exceed 100 MiB",
          );
        db.query(
          "UPDATE attachments SET size=? WHERE id=? AND state='uploading'",
        ).run(size, id);
      }).immediate();
      let offset = 0;
      while (offset < chunk.value.byteLength)
        offset += writeSync(
          fd,
          chunk.value,
          offset,
          chunk.value.byteLength - offset,
        );
    }
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    db.query("UPDATE attachments SET state='ready' WHERE id=?").run(id);
    return { id, name, mime: input.mime, size };
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (fd !== undefined) closeSync(fd);
    for (const file of [temp, path])
      try {
        unlinkSync(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    db.query("DELETE FROM attachments WHERE id=?").run(id);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
export function deleteAttachment(ctx: Ctx, draftId: string, id: string): void {
  requireDraft(ctx, draftId);
  const db = database(ctx),
    row = db
      .query<
        Row,
        [string, string]
      >("SELECT * FROM attachments WHERE id=? AND draft=?")
      .get(id, draftId);
  if (!row)
    throw new CoreError(
      "not_found",
      "Attachment does not belong to this draft",
    );
  if (row.task || row.state !== "ready")
    throw new CoreError("conflict", "This attachment is in use");
  try {
    unlinkSync(join(attachmentDirectory(ctx, row.draft), row.id));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  db.query("DELETE FROM attachments WHERE id=?").run(id);
}
export function draftAttachment(
  ctx: Ctx,
  draftId: string,
  id: string,
): AttachmentRef {
  requireDraft(ctx, draftId);
  const row = database(ctx)
    .query<
      Row,
      [string, string]
    >("SELECT * FROM attachments WHERE id=? AND draft=? AND state='ready'")
    .get(id, draftId);
  if (!row)
    throw new CoreError(
      "not_found",
      "Attachment does not belong to this draft",
    );
  const path = join(attachmentDirectory(ctx, row.draft), row.id),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new CoreError(
      "not_allowed",
      "Attachment is not a regular private file",
    );
  return { ...metadata(row), path };
}
export function claimAttachments(
  ctx: Ctx,
  input: { ids: string[]; draftId: string; taskId: string },
): void {
  const draft = requireDraft(ctx, input.draftId),
    db = database(ctx);
  if (draft.task && draft.task !== input.taskId)
    throw new CoreError("conflict", "Draft already belongs to another session");
  if (input.ids.length > 20 || new Set(input.ids).size !== input.ids.length)
    throw new CoreError(
      "invalid_input",
      "Choose at most 20 distinct attachments",
    );
  for (const id of input.ids) draftAttachment(ctx, input.draftId, id);
  db.query("UPDATE attachment_drafts SET task=? WHERE id=?").run(
    input.taskId,
    input.draftId,
  );
  for (const id of input.ids)
    db.query("UPDATE attachments SET task=? WHERE id=? AND draft=?").run(
      input.taskId,
      id,
      input.draftId,
    );
}
export function resolveAttachments(
  ctx: Ctx,
  taskId: string,
  ids?: string[],
): AttachmentRef[] {
  const rows = database(ctx)
    .query<
      Row,
      [string]
    >("SELECT * FROM attachments WHERE task=? AND state='ready'")
    .all(taskId);
  const selected = ids
    ? ids.map((id) => {
        const row = rows.find((r) => r.id === id);
        if (!row)
          throw new CoreError(
            "not_found",
            "Attachment does not belong to this session",
          );
        return row;
      })
    : rows;
  return selected.map((row) => {
    const path = join(attachmentDirectory(ctx, row.draft), row.id),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new CoreError(
        "not_allowed",
        "Attachment is not a regular private file",
      );
    return { ...metadata(row), path };
  });
}
export async function expireDraftAttachments(ctx: Ctx): Promise<number> {
  const db = database(ctx),
    drafts = db
      .query<
        { id: string },
        [number]
      >("SELECT id FROM attachment_drafts WHERE task IS NULL AND created<=?")
      .all(ctx.now - 86400);
  for (const draft of drafts) {
    for (const row of db
      .query<Row, [string]>("SELECT * FROM attachments WHERE draft=?")
      .all(draft.id)) {
      for (const suffix of ["", ".upload"])
        try {
          unlinkSync(join(root(ctx), draft.id, row.id + suffix));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
    }
    db.transaction(() => {
      db.query("DELETE FROM attachments WHERE draft=?").run(draft.id);
      db.query("DELETE FROM attachment_drafts WHERE id=?").run(draft.id);
    }).immediate();
  }
  return drafts.length;
}
