import { expect, test } from "bun:test";
import { outcome } from "../src/exec/direct";
import * as protocol from "../src/plugins/executor-protocol";

test("the future owned-attempt result accepts a real direct outcome and rejects incomplete records", () => {
  const contract = (protocol as Record<string, unknown>).executorAttemptOutcome as
    { safeParse(value: unknown): { success: boolean } } | undefined;
  expect(contract).toBeDefined();
  const actual = outcome({ id: "codex", model: null } as never, 1,
    { code: 0, stdout: "done", stderr: "", timedOut: false }, "/tmp/run.log", "done");
  expect(contract!.safeParse(actual).success).toBe(true);
  expect(contract!.safeParse({ ...actual, attempt: { ...actual.attempt, exitCode: "zero" } }).success).toBe(false);
  expect(contract!.safeParse({ ...actual, exec: { ...actual.exec, timedOut: "no" } }).success).toBe(false);
  expect(contract!.safeParse({ ...actual, report: undefined }).success).toBe(false);
});

test("the future run-directory contract names the files existing readers use", () => {
  expect((protocol as Record<string, unknown>).RUN_DIR_CONTRACT).toEqual({
    version: 1,
    files: ["argv", "stdout", "stderr", "pid", "exit", "session.log", "session.json",
      "report.json", "transcript-report.md", "prompt.md"],
  });
});

test("only the owned conversation arm accepts a bounded running result", () => {
  const owned = { task: { id: "t-conversation", rev: 2 }, attempt: 1, runDir: 1,
    owned: { placement: "current", timeoutMs: 5000, session: "conversation",
      executor: "codex", model: null } };
  expect(protocol.executorOwnedRunParams.safeParse(owned).success).toBe(true);
  const running = { status: "running", taskId: "t-conversation", attempt: 1, startedAt: 100 };
  expect(protocol.executorRunResult.safeParse(running).success).toBe(true);
  expect(protocol.executorAttemptOutcome.safeParse(running).success).toBe(false);
  expect(protocol.executorRunResult.safeParse({ ...running, attempt: "1" }).success).toBe(false);
  expect(protocol.executorRunResult.safeParse({ ...running, startedAt: "100" }).success).toBe(false);
  expect(protocol.executorRunResult.safeParse({ ...running, dir: "/tmp/unissued" }).success).toBe(false);
});
