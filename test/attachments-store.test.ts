import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { createDraft, storeAttachment, listAttachments, deleteAttachment, expireDraftAttachments } from "../src/attachments/store";
import { retentionScheduler } from "../src/tasks/retention";

test("the service retention tick removes expired private drafts", async () => {
  const ctx = fakeCtx(), draftId = createDraft(ctx).id;
  await storeAttachment(ctx, {draftId, batchId: "one", name: "private.txt", mime: "text/plain", body: body(3)});
  await retentionScheduler().tick({...ctx, now: ctx.now + 86401});
  expect(() => listAttachments(ctx, draftId)).toThrow();
});

function body(size: number) {
  return new ReadableStream<Uint8Array>({start(c) {c.enqueue(new Uint8Array(size)); c.close();}});
}
test("uploads enforce per-file and batch limits while retaining safe display names", async () => {
  const ctx = fakeCtx(), draftId = createDraft(ctx).id;
  const first = await storeAttachment(ctx, {draftId, batchId: "batch", name: "../../secret.txt", mime: "text/plain", body: body(1)});
  expect(first.name).toBe("secret.txt");
  expect(first).not.toHaveProperty("path");
  for (let i = 1; i < 20; i++) await storeAttachment(ctx, {draftId, batchId: "batch", name: "file.txt", mime: "text/plain", body: body(0)});
  await expect(storeAttachment(ctx, {draftId, batchId: "batch", name: "extra", mime: "text/plain", body: body(0)})).rejects.toMatchObject({code: "too_large"});
  await expect(storeAttachment(ctx, {draftId, batchId: "other", name: "large", mime: "text/plain", body: body(25 * 1024 * 1024 + 1)})).rejects.toMatchObject({code: "too_large"});
  expect(listAttachments(ctx, draftId)).toHaveLength(20);
});
test("a cancelled stream releases reservations and a foreign draft cannot remove files", async () => {
  const ctx = fakeCtx(), draftId = createDraft(ctx).id, foreign = createDraft(ctx).id;
  await expect(storeAttachment(ctx, {draftId, batchId: "one", name: "bad", mime: "text/plain", body: new ReadableStream({pull(c) {c.error(Error("cancelled"));}})})).rejects.toThrow("cancelled");
  expect(listAttachments(ctx, draftId)).toEqual([]);
  const file = await storeAttachment(ctx, {draftId, batchId: "one", name: "fine", mime: "text/plain", body: body(3)});
  expect(() => deleteAttachment(ctx, foreign, file.id)).toThrow();
  expect(listAttachments(ctx, draftId)).toHaveLength(1);
  expect(await expireDraftAttachments({...ctx, now: ctx.now + 86401})).toBe(2);
  expect(() => listAttachments(ctx, draftId)).toThrow();
});
test("concurrent uploads cannot exceed aggregate quota", async () => {
  const ctx = fakeCtx(), draftId = createDraft(ctx).id;
  const uploads = await Promise.allSettled(Array.from({length: 5}, () => storeAttachment(ctx, {draftId, batchId: "one", name: "big", mime: "application/octet-stream", body: body(25 * 1024 * 1024)})));
  expect(uploads.filter(r => r.status === "fulfilled")).toHaveLength(4);
  expect(listAttachments(ctx, draftId).reduce((n, f) => n + f.size, 0)).toBe(100 * 1024 * 1024);
});
