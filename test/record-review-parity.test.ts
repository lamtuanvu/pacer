import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { KINDS } from "../src/config/strategy";
import { taskReview } from "../src/tasks/api";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");

function rustRecord(
  pacerHome: string,
  id: string,
  accepted: boolean,
  kind: string | null,
  note: string | null,
  expectRev: number | null,
  now: number,
) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--bin", "record_review_probe"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
  });
  const probe = join(TARGET, "debug", "record_review_probe");
  const out = execFileSync(
    probe,
    [
      pacerHome,
      id,
      accepted ? "accept" : "reject",
      kind ?? "",
      note ?? "",
      expectRev === null ? "" : String(expectRev),
      String(now),
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as { review: { accepted: boolean; kind: string | null; note: string | null; at: number }; resolved: string; rev: number };
}

test("TASK_KINDS stays aligned with strategy KINDS", () => {
  const expected = [
    "boilerplate",
    "tests",
    "docs",
    "rename",
    "migration",
    "feature",
    "debug",
    "refactor",
    "performance",
    "unfamiliar-code",
    "research",
  ] as const;
  expect([...KINDS].sort()).toEqual([...expected].sort());
});

test("record_review_verdict matches taskReview store fields", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, {
    brief: { goal: "g", repo: ctx.home },
    kind: "feature",
    requestedExecutor: null,
    timeoutS: 60,
  });
  updateTask(ctx, t.id, (x) => {
    x.state = "done";
  });
  taskReview(ctx, t.id, true, undefined, "  ship it  ");
  const ts = readTask(ctx, t.id)!;
  expect(ts.review).toMatchObject({ accepted: true, kind: "feature", note: "  ship it  " });
  expect(ts.resolved).toBe("reviewed");

  const other = fakeCtx();
  const seeded = createTask(other, {
    brief: { goal: "g", repo: other.home },
    kind: "feature",
    requestedExecutor: null,
    timeoutS: 60,
  });
  updateTask(other, seeded.id, (x) => {
    x.state = "partial";
  });
  const rust = rustRecord(other.pacerHome, seeded.id, true, null, "ship it", 2, other.now);
  expect(rust.review).toMatchObject({ accepted: true, kind: "feature", note: "ship it", at: other.now });
  expect(rust.resolved).toBe("reviewed");
});
