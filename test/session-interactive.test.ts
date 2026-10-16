import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir, fakeCtx } from "./helpers";
import { prepareInteractive, readReport, writeReport, agentHook, transcriptReport } from "../src/session/reports";
import { main } from "../src/cli";

test("explicit reports validate status and summary and terminal reports survive late hooks", () => {
  const dir = tmpDir();
  expect(() => writeReport(dir, "done", "")).toThrow("summary");
  expect(() => writeReport(dir, "unknown", "summary")).toThrow("status");
  writeReport(dir, "needs-input", "Approve the command");
  expect(readReport(dir)?.status).toBe("needs-input");
  writeReport(dir, "running", "Working again");
  writeReport(dir, "done", "Implemented and checked");
  agentHook(dir, { hook_event_name: "Stop", last_assistant_message: "late hook" });
  expect(readReport(dir)).toMatchObject({status: "done", summary: "Implemented and checked"});
});

test("Claude hooks signal waiting and working, capture transcripts, and never infer task completion", () => {
  const dir = tmpDir(), transcript = join(dir, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({type: "assistant", message: {content: [{type: "text", text: "Here is the result"}]}}) + "\n");
  agentHook(dir, {hook_event_name: "PermissionRequest", transcript_path: transcript});
  expect(readReport(dir)?.status).toBe("needs-input");
  agentHook(dir, {hook_event_name: "PostToolUse", transcript_path: transcript});
  expect(readReport(dir)?.status).toBe("running");
  agentHook(dir, {hook_event_name: "Stop", transcript_path: transcript});
  expect(readReport(dir)?.status).toBe("turn-ended");
  expect(transcriptReport(dir)).toBe("Here is the result");
  agentHook(dir, {hook_event_name: "Notification", notification_type: "auth_success", message: "Ignore"});
  expect(readReport(dir)?.status).toBe("turn-ended");
});

test("per-launch settings stay in run directory; other agents keep account environment", () => {
  const dir = tmpDir();
  const launch = {argv: ["claude", "PROMPT"], cwd: dir};
  const prepared = prepareInteractive("claude-code", dir, launch);
  expect(prepared.argv).toContain("--settings");
  const settings = JSON.parse(readFileSync(prepared.argv[prepared.argv.indexOf("--settings") + 1], "utf8"));
  expect(settings.hooks.PermissionRequest[0].hooks[0].command).toContain("report-hook.sh");
  expect(settings.hooks.Stop[0].hooks[0].command).toContain(dir);
  expect(prepareInteractive("cursor", dir, {argv: ["cursor-agent", "P"], cwd: dir}).argv).toEqual(["cursor-agent", "P"]);
});

test("pacer report accepts launch environment and rejects invalid input", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "interactive.json"), "{}");
  const ctx = fakeCtx({env: {PACER_RUN_DIR: dir}});
  expect((await main(["report", "--status", "failed", "--summary", "Checks failed"], ctx)).code).toBe(0);
  expect(readReport(dir)).toMatchObject({status: "failed", summary: "Checks failed"});
  expect((await main(["report", "--status", "done"], ctx)).code).toBe(2);
});

test("question tool hooks wait for the user rather than appearing active", () => {
  const dir = tmpDir();
  agentHook(dir, {hook_event_name: "PreToolUse", tool_name: "AskUserQuestion"});
  expect(readReport(dir)?.status).toBe("needs-input");
  agentHook(dir, {hook_event_name: "PostToolUse", tool_name: "AskUserQuestion"});
  expect(readReport(dir)?.status).toBe("running");
});

test("executor environment does not inherit the parent interactive report destination", async () => {
  const {executorEnv} = await import("../src/exec/process");
  expect(executorEnv({PACER_RUN_DIR: "parent", PACER_TRANSCRIPT_REPORT: "parent/report.md"}, {})).not.toHaveProperty("PACER_RUN_DIR");
  expect(executorEnv({PACER_TRANSCRIPT_REPORT: "parent/report.md"}, {})).not.toHaveProperty("PACER_TRANSCRIPT_REPORT");
});

test("pacer report can address a running task explicitly outside the agent environment", async () => {
  const {createTask, updateTask} = await import("../src/tasks/store");
  const ctx = fakeCtx(), dir = tmpDir();
  writeFileSync(join(dir, "interactive.json"), "{}");
  const task = createTask(ctx, {brief: {goal: "Task", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 30});
  updateTask(ctx, task.id, t => {t.state = "running"; t.run = {dir, attempt: 1, executor: "codex", startedAt: 1, mode: "current", workdir: dir, logFile: join(dir, "log")};});
  expect((await main(["report", task.id, "--status", "done", "--summary", "User completed it"], ctx)).code).toBe(0);
  expect(readReport(dir)?.summary).toBe("User completed it");
  expect((await main(["report", "../bad", "--status", "done", "--summary", "Invalid"], ctx)).code).toBe(2);
  updateTask(ctx, task.id, t => {t.state = "done";});
  expect((await main(["report", task.id, "--status", "failed", "--summary", "Too late"], ctx)).code).toBe(2);
});

test("Codex hooks use per-invocation config with a run-local script and preserve CODEX_HOME", () => {
  const dir = tmpDir();
  const prepared = prepareInteractive("codex", dir, {argv: ["codex", "PROMPT"], cwd: dir});
  const flags = prepared.argv.filter((_, i, a) => i > 0 && a[i - 1] === "-c");
  expect(flags.some(f => f.startsWith("hooks.PermissionRequest="))).toBe(true);
  expect(flags.some(f => f.startsWith("hooks.Stop="))).toBe(true);
  expect(readFileSync(join(dir, "report-hook.sh"), "utf8")).toContain("_session-hook");
  expect(prepared.argv).not.toContain("CODEX_HOME");
});

test("Codex transcript hook extracts assistant messages and question signals", () => {
  const dir = tmpDir(), transcript = join(dir, "rollout.jsonl");
  writeFileSync(transcript, JSON.stringify({type: "response_item", payload: {type: "message", role: "assistant", content: [{type: "output_text", text: "Codex result"}]}}) + "\n");
  agentHook(dir, {hook_event_name: "Stop", transcript_path: transcript});
  expect(transcriptReport(dir)).toBe("Codex result");
  agentHook(dir, {hook_event_name: "PreToolUse", tool_name: "request_user_input"});
  expect(readReport(dir)?.status).toBe("needs-input");
});

test("spec report syntax writes the authoritative run-local report.json", async () => {
  const dir = tmpDir(), ctx = fakeCtx({env: {PACER_RUN_DIR: dir}});
  writeFileSync(join(dir, "interactive.json"), "{}");
  expect((await main(["report", "--outcome", "done", "--summary", "Finished"], ctx)).code).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8"))).toMatchObject({status: "done", summary: "Finished"});
});

test("hooks append structured launch events and Stop records a turn end, not immediate waiting", () => {
  const dir = tmpDir();
  agentHook(dir, {hook_event_name: "PreToolUse"});
  agentHook(dir, {hook_event_name: "Stop"});
  expect(readReport(dir)?.status).toBe("turn-ended");
  expect(readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l).event)).toEqual(["PreToolUse", "Stop"]);
});
