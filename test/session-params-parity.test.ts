import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opJsonSchemas } from "../src/api/ops";
import { sessionOps } from "../src/api/ops-session";

void opJsonSchemas;

const draftId = "00000000-0000-4000-8000-000000000000";
const createBase = {
  request_id: "request",
  draftId,
  request: "x",
  repo: "/repo",
  executor: "codex",
  workspace: { mode: "current" as const, path: "/repo" },
  attachments: [] as string[],
};

function parse(op: string, params: unknown): boolean {
  return sessionOps[op].params.safeParse(params).success;
}

test("session operation param bounds match the Rust params module goldens", () => {
  const rows = {
    session_id: [
      { input: "t-20261027-120000-abcd", valid: true },
      { input: "request", valid: true },
      { input: "", valid: false },
      { input: "é", valid: false },
      { input: "a".repeat(129), valid: false },
    ],
    draft_uuid: [
      { input: draftId, valid: true },
      { input: "00000000-0000-0000-0000-000000000000", valid: true },
      { input: "ffffffff-ffff-ffff-ffff-ffffffffffff", valid: true },
      { input: "bad", valid: false },
      { input: "00000000-0000-9000-8000-000000000000", valid: false },
    ],
    agent_uuid: [
      { input: "550e8400-e29b-41d4-a716-446655440000", valid: true },
      { input: draftId, valid: true },
      { input: "not-a-uuid", valid: false },
    ],
    request_length: [
      { input: "😀".repeat(200_000), valid: true },
      { input: "😀".repeat(200_001), valid: false },
      { input: "", valid: false },
    ],
    expect_rev: [
      { input: 1, valid: true },
      { input: 9007199254740991, valid: true },
      { input: 0, valid: false },
      { input: 1.5, valid: false },
    ],
    op_parse: [
      { op: "session.create", params: { ...createBase, request: "😀".repeat(200_000) }, valid: true },
      { op: "session.create", params: { ...createBase, request: "😀".repeat(200_001) }, valid: false },
      { op: "session.create", params: { ...createBase, request_id: "é" }, valid: false },
      { op: "session.create", params: { ...createBase, attachments: Array(21).fill(draftId) }, valid: false },
      { op: "session.create", params: { ...createBase, workspace: { mode: "new", base: "" } }, valid: false },
      { op: "session.resume", params: { id: "task", expect_rev: 1.5 }, valid: false },
      { op: "session.resume", params: { id: "task", expect_rev: 0 }, valid: false },
      { op: "session.file.read", params: { id: "task", attempt: 1.5, reference: "file" }, valid: false },
      { op: "session.attachment.prepare", params: { id: "task", attachmentId: "bad" }, valid: false },
      { op: "session.draft.create", params: {}, valid: true },
      { op: "session.prepare", params: { repo: "/repo" }, valid: true },
      { op: "session.context", params: { id: "task" }, valid: true },
      { op: "session.end", params: { id: "task", expect_rev: 1 }, valid: true },
      { op: "session.agent.create", params: { task_id: "task", request_id: "task", executor: "codex", request: "hi" }, valid: true },
      { op: "session.agent.end", params: { task_id: "task", id: draftId, expect_rev: 1 }, valid: true },
    ],
  } as const;

  for (const row of rows.op_parse) {
    expect(parse(row.op, row.params), row.op).toBe(row.valid);
  }

  const path = join(import.meta.dir, "fixtures", "session-ops", "params.json");
  if (process.env.PACER_UPDATE_SESSION_OPS_GOLDENS === "1") {
    writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
  }
  expect(rows).toEqual(JSON.parse(readFileSync(path, "utf8")));
});
