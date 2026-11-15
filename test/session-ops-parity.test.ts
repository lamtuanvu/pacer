import { policyGateFixture } from "./fixtures/policy-host";
import { resolveRepo } from "../src/core/repos";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { callOp, opJsonSchemas } from "../src/api/ops";
import { sessionOps } from "../src/api/ops-session";
import { writeJsonAtomic } from "../src/fsutil";
import { fakeCtx } from "./helpers";
import contracts from "./fixtures/session-ops/contracts.json";
import { fileHome, outcome, pureReference, sessionId } from "./session-ops-reference";
import { createConversation } from "../src/session/create";
import * as attachments from "../src/attachments/store";
import { gitRepo, realRun, tmpDir, withLoginIndicators } from "./helpers";
import { createTask, readTask, updateTask, listTasksWhere } from "../src/tasks/store";
import { agentHook, readReport, reportCommand, writeReport } from "../src/session/reports";
import { promptHook, stopHook } from "../src/messaging/hooks";
import * as messages from "../src/messaging/store";
import { claimTurnMessages, onRunEnded, renderTurnPrompt, renderReplayThread } from "../src/messaging/turns";
import { readSessionFile } from "../src/session/files";

// These are TS reference contracts, not a claim that the Rust dispatcher owns them.
// Include the handoff operations so a future port cannot silently narrow the seam.
test("session and handoff operation schemas match the captured TypeScript contracts", () => {
  const schemas = opJsonSchemas();
  for (const [name, golden] of Object.entries(contracts)) expect(schemas[name]).toEqual(golden);
});

test("session API validates Unicode length and integer boundaries before effects", async () => {
  const ctx = fakeCtx();
  const draftId = "00000000-0000-4000-8000-000000000000";
  const create = { request_id: "request", draftId, request: "x", repo: "/repo", executor: "codex", workspace: { mode: "current", path: "/repo" }, attachments: [] };
  // Zod counts Unicode code points here, rather than String.length UTF-16 units.
  expect(sessionOps["session.create"].params.safeParse({ ...create, request: "😀".repeat(200000) }).success).toBe(true);
  expect(sessionOps["session.create"].params.safeParse({ ...create, request: "😀".repeat(200001) }).success).toBe(false);
  const invalid: [string, unknown][] = [
    ["session.create", { ...create, request: "😀".repeat(200001) }],
    ["session.create", { ...create, request_id: "é" }],
    ["session.create", { ...create, attachments: Array(21).fill(draftId) }],
    ["session.create", { ...create, workspace: { mode: "new", base: "" } }],
    ["session.resume", { id: "task", expect_rev: 1.5 }],
    ["session.resume", { id: "task", expect_rev: 0 }],
    ["session.file.read", { id: "task", attempt: 1.5, reference: "file" }],
    ["session.attachment.prepare", { id: "task", attachmentId: "bad" }],
    ["account.signin", { name: "account", target: "shell" }],
    ["strategy.build", { brief: "😀".repeat(2001) }],
    ["host.terminal", { alias: "" }],
    ["msg.send", { to: "human", body: "" }],
    ["msg.inbox", { limit: 1.5 }],
    ["msg.inbox", { limit: 1, extra: true }],
    ["msg.wait", { timeout_s: 3001 }],
  ];
  for (const [name, params] of invalid) {
    try { await callOp(ctx, name, params); throw Error(`accepted ${name}`); } catch (error) { expect((error as { code?: string }).code, name).toBe("invalid_input"); }
  }
});

test("file read and resume preserve attempt and revision conflicts", async () => {
  const ctx = fakeCtx();
  const id = "t-20261027-120000-abcd";
  const workdir = join(ctx.home, "repo");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "hello.txt"), "hello\n");
  writeJsonAtomic(join(ctx.pacerHome, "tasks", `${id}.json`), {
    id, rev: 2, state: "stopped", createdAt: 1, brief: { goal: "view", repo: workdir }, attempts: [],
    interactionMode: "conversation", conversation: { activity: "ended", agentSessionId: "native" },
    run: { attempt: 2, workdir, dir: join(ctx.pacerHome, "runs", id, "2"), host: null, mode: "current" },
  } as any);
  expect(await callOp(ctx, "session.file.read", { id, attempt: 2, reference: "hello.txt:1:2" })).toMatchObject({ path: "hello.txt", text: "hello\n", line: 1, column: 2 });
  await expect(callOp(ctx, "session.file.read", { id, attempt: 1, reference: "hello.txt" })).rejects.toMatchObject({ code: "conflict" });
  await expect(callOp(ctx, "session.file.read", { id, attempt: 2, reference: "../secret" })).rejects.toMatchObject({ code: "not_allowed" });
  await expect(callOp(ctx, "session.resume", { id, expect_rev: 1 })).rejects.toMatchObject({ code: "conflict" });
});


function golden(name: string, actual: unknown) {
  const path = join(import.meta.dir, "fixtures", "session-ops", `${name}.json`);
  if (process.env.PACER_UPDATE_SESSION_OPS_GOLDENS === "1") writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
  expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
}
function configured(run = realRun) {
  const ctx = fakeCtx({ run });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {codex: {}, cursor: {}}\nhosts: {devbox: {ssh: fixture-host}}\n");
  return ctx;
}
function normalized(value: unknown, replacements: [string, string][]): unknown {
  // Replace only fixture coordinates/identities; statuses, revisions, text and codes survive.
  const text = JSON.stringify(value);
  return JSON.parse(replacements.sort((a, b) => b[0].length - a[0].length).reduce((s, [from, to]) => s.split(from).join(to), text));
}

test("TS file-reference and report normalization goldens shared with the dormant Rust library", async () => {
  golden("pure", await pureReference());
});

test("conversation creation, attachments and checkout ownership retain atomic idempotent effects", async () => {
  const repo = gitRepo(), ctx = configured(async (args, timeout, options) => args[0] === "codex"
    ? { code: 0, stdout: args[1] === "--version" ? "codex-cli 0.163.0" : "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust", stderr: "" }
    : realRun(args, timeout, options)), draft = attachments.createDraft(ctx);
  const upload = (name: string, draftId = draft.id) => attachments.storeAttachment(ctx, {
    draftId, batchId: "batch", name, mime: "text/plain", body: new Blob(["hello"]).stream(),
  });
  const file = await upload("..\\secret\u0000.txt");
  const repoRef = await resolveRepo(ctx, repo);
  const deps = {
    prepare: async () => ({ repo: repoRef, branches: ["main"], base: "main",
      checkouts: [{ path: repo, branch: "main", dirty: false }],
      executors: [{ id: "codex", agent: "codex", account: "default", version: "0.163.0", available: true,
        capabilities: { interactive: true, resume: true, launchImages: true, liveImages: false, files: true } }] }),
    spawnRunner: () => { spawns++; return process.pid; },
  };
  let spawns = 0;
  const input = { request_id: "first", draftId: draft.id, request: "  Explain 😀  ", repo, executor: "codex",
    workspace: { mode: "current" as const, path: repo }, attachments: [file.id] };
  const first = await createConversation(ctx, input, deps);
  const again = await createConversation(ctx, input, deps);
  const task = readTask(ctx, first.task_id)!;
  const failures = {
    changed: await outcome(() => createConversation(ctx, { ...input, request: "different" }, deps)),
    duplicateAttachment: await outcome(() => attachments.claimAttachments(ctx, { draftId: draft.id, taskId: task.id, ids: [file.id, file.id] })),
    deleteClaimed: await outcome(() => attachments.deleteAttachment(ctx, draft.id, file.id)),
    foreignOwner: await outcome(() => attachments.claimAttachments(ctx, { draftId: draft.id, taskId: "other", ids: [file.id] })),
    blank: await outcome(() => createConversation(ctx, { ...input, request_id: "blank", request: "\ufeff\u00a0\u2028 " }, deps)),
    executor: await outcome(() => createConversation({ ...ctx, env: { PACER_ROLE: "executor" } }, input, deps)),
    checkout: await outcome(() => createConversation(ctx, { ...input, request_id: "second", draftId: attachments.createDraft(ctx).id, attachments: [] }, deps)),
  };
  const claimed = attachments.resolveAttachments(ctx, task.id);
  const context = await callOp(ctx, "session.context", { id: task.id });
  const filePath = claimed[0]!.path;
  golden("creation", normalized({ first, again, spawns, task: { state: task.state, rev: task.rev, goal: task.brief.goal,
    interactionMode: task.interactionMode, conversation: task.conversation, placement: task.placement, executor: task.requestedExecutor },
    context, claimed, failures, mode: { file: statSync(filePath).mode & 0o777, directory: statSync(join(ctx.pacerHome, "attachments", draft.id)).mode & 0o777 } },
    [[task.id, "$TASK"], [file.id, "$FILE"], [draft.id, "$DRAFT"], [ctx.home, "$HOME"]]));
  const fresh = { ...input, request_id: "new", draftId: attachments.createDraft(ctx).id, workspace: { mode: "new" as const, base: "main" }, attachments: [] };
  const before = listTasksWhere(ctx, {}).length;
  const rollback = await outcome(() => createConversation(ctx, { ...fresh, attachments: [file.id] }, deps));
  const after = listTasksWhere(ctx, {}).length;
  const invalidBase = await outcome(() => createConversation(ctx, { ...fresh, workspace: { mode: "new", base: "main..bad" } }, deps));
  const failed = await createConversation(ctx, fresh, { ...deps, spawnRunner: () => { throw Error("fixture spawn failed"); } });
  const failedTask = readTask(ctx, failed.task_id)!;
  golden("creation-recovery", normalized({ rollback, taskCounts: [before, after], invalidBase, failed,
    state: failedTask.state, conversation: failedTask.conversation, result: failedTask.result }, [[failed.task_id, "$FAILED"]]));
  const late = await upload("later.txt");
  updateTask(ctx, task.id, t => { t.state = "running"; });
  const delivery = await callOp(ctx, "session.attachment.prepare", { id: task.id, attachmentId: late.id });
  golden("attachment-delivery", normalized({ delivery, claimed: attachments.resolveAttachments(ctx, task.id).map(f => f.name) },
    [[late.id, "$LATE"], [draft.id, "$DRAFT"], [ctx.home, "$HOME"]]));
  golden("attachment-errors", {
    stopped: await outcome(() => callOp(ctx, "session.attachment.prepare", { id: failed.task_id, attachmentId: late.id })),
    foreignDraft: await outcome(() => attachments.draftAttachment(ctx, attachments.createDraft(ctx).id, late.id)),
    expired: await outcome(() => attachments.listAttachments({ ...ctx, now: ctx.now + 86400 }, attachments.createDraft(ctx).id)),
    claimMissing: await outcome(() => attachments.claimAttachments(ctx, { draftId: draft.id, taskId: task.id, ids: ["00000000-0000-4000-8000-000000000000"] })),
  });
});

test("resume captures successful queuing, conflicts, missing identity and launch recovery", async () => {
  const probes: string[][] = [];
  const ctx = withLoginIndicators(configured(async (args, timeout, options) => {
    if (args[0] !== "codex") return realRun(args, timeout, options);
    probes.push(args.slice(1));
    return { code: 0, stdout: args[1] === "--version" ? "codex-cli 0.163.0" : "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust", stderr: "" };
  }));
  const repo = gitRepo();
  const make = () => {
    const task = createTask(ctx, { brief: { goal: "Explain", repo }, kind: null, requestedExecutor: "codex", timeoutS: 0, interactionMode: "conversation" });
    return updateTask(ctx, task.id, t => { t.state = "stopped"; t.conversation = { activity: "ended", agentSessionId: "native-id" };
      t.result = { status: "stopped", executor: "codex", model: null, files: "", report: "Retained output", backend: "direct" }; });
  };
  const task = make();
  const stale = await outcome(() => callOp(ctx, "session.resume", { id: task.id, expect_rev: task.rev - 1 }));
  let launches = 0;
  const failed = await outcome(() => callOp(ctx, "session.resume", { id: task.id, expect_rev: task.rev }, { spawnRunner: () => { launches++; throw Error("fixture spawn failed"); } }));
  const afterFailure = readTask(ctx, task.id)!;
  const success = await callOp(ctx, "session.resume", { id: task.id, expect_rev: afterFailure.rev }, { spawnRunner: () => { launches++; return process.pid; } });
  const queued = readTask(ctx, task.id)!;
  const active = await outcome(() => callOp(ctx, "session.resume", { id: task.id, expect_rev: queued.rev }));
  const missing = make();
  updateTask(ctx, missing.id, t => { t.conversation = { activity: "ended" }; });
  const noIdentity = await outcome(() => callOp(ctx, "session.resume", { id: missing.id, expect_rev: readTask(ctx, missing.id)!.rev }));
  golden("resume", normalized({ stale, failed, launches, probes, afterFailure: { state: afterFailure.state, result: afterFailure.result, conversation: afterFailure.conversation },
    success, queued: { state: queued.state, conversation: queued.conversation, result: queued.result ?? null, run: queued.run ?? null, queue: queued.queue ?? null }, active, noIdentity }, [[task.id, "$TASK"]]));
});

test("file read goldens retain local attempt, content and private-state boundaries", async () => {
  const { ctx, workdir } = fileHome();
  writeFileSync(join(workdir, "hello.MDOWN"), "# 😀\n");
  writeFileSync(join(workdir, "page.HTM"), "<p>hello</p>");
  writeFileSync(join(workdir, "binary"), Buffer.from([0, 1]));
  writeFileSync(join(workdir, "invalid"), Buffer.from([0xff]));
  writeFileSync(join(workdir, "large"), Buffer.alloc(512 * 1024 + 1, 65));
  symlinkSync(ctx.pacerHome, join(workdir, "private"));
  const results: Record<string, unknown> = {};
  for (const reference of ["hello.MDOWN:1:2", "page.HTM", "binary", "invalid", "large", "gone", "../secret", "private/tasks/" + sessionId + ".json"]) {
    results[reference.replace(sessionId, "$TASK")] = await outcome(() => {
      const { modified, ...result } = readSessionFileForGolden(ctx, reference);
      expect(Number.isFinite(Date.parse(modified))).toBe(true);
      return result;
    });
  }
  golden("files", results);
});
function readSessionFileForGolden(ctx: ReturnType<typeof fakeCtx>, reference: string) {
  // Synchronous helper keeps the exact CoreError produced by the secure openat reader.
  return readSessionFile(ctx, { id: sessionId, attempt: 2, reference });
}

test("account sign-in, strategy planning and host terminal preserve their terminal handoff", async () => {
  const ctx = configured(async () => ({ code: 127, stdout: "", stderr: "fixture unavailable" }));
  const terminal = { platform: "linux" as const, which: () => null, env: {}, orcaAvailable: async () => false };
  const signin = await callOp(ctx, "account.signin", { name: "codex" }, { terminal });
  const signinMissing = await outcome(() => callOp(ctx, "account.signin", { name: "missing" }, { terminal }));
  const opened: unknown[] = [];
  const open: NonNullable<Parameters<typeof callOp>[3]>["openTerminal"] = async (_ctx, options) => {
    opened.push(options);
    return { opened: true, target: "terminal", command: "fixture command" };
  };
  const host = await callOp(ctx, "host.terminal", { alias: "devbox" }, { openTerminal: open });
  const unknownHost = await outcome(() => callOp(ctx, "host.terminal", { alias: "missing" }, { openTerminal: open }));
  const request_id = "00000000-0000-4000-8000-000000000001";
  const strategy = await callOp(ctx, "strategy.build", { agent: "cursor", from: "default", brief: "Help 😀", request_id }, { openTerminal: open });
  const again = await callOp(ctx, "strategy.build", { agent: "cursor", from: "default", brief: "Help 😀", request_id }, { openTerminal: open });
  const changed = await outcome(() => callOp(ctx, "strategy.build", { agent: "cursor", brief: "changed", request_id }, { openTerminal: open }));
  const unicodeLimit = await outcome(() => callOp(ctx, "strategy.build", { brief: "😀".repeat(1001) }, { openTerminal: open }));
  // The generated strategy prompt includes the full status clock: capture its stable semantic parts.
  const calls = (opened as { argv: string[]; title: string; requestId?: string }[]).map(o => o.argv[0] === "ssh" ? o : {
    argv: o.argv.slice(0, -1), title: o.title, requestId: o.requestId,
    prompt: { heading: o.argv.at(-1)!.startsWith("# Build a pacer strategy\n\nHelp 😀"),
      base: o.argv.at(-1)!.includes("Base: default"), approval: o.argv.at(-1)!.includes("Save only after explicit approval") },
  });
  golden("terminal-handoff", normalized({ signin, signinMissing, host, unknownHost, strategy, again, changed, unicodeLimit, calls,
    samePrompt: (opened[1] as any).argv.at(-1) === (opened[2] as any).argv.at(-1),
    intentFiles: readdirSync(join(ctx.pacerHome, "link", "sessions")).sort() }, [[ctx.home, "$HOME"]]));
});

test("hook/report handoff preserves attempt credentials, terminal precedence and conversation turns", async () => {
  const { ctx } = fileHome();
  const dir = join(ctx.pacerHome, "runs", sessionId, "2");
  mkdirSync(dir, { recursive: true });
  updateTask(ctx, sessionId, t => { t.state = "running"; });
  writeFileSync(join(dir, "interactive.json"), JSON.stringify({ interactionMode: "conversation", reportToken: "fixture-token" }));
  const agentCtx = { ...ctx, env: { PACER_RUN_DIR: dir, PACER_REPORT_TOKEN: "fixture-token", PACER_ROLE: "executor" } };
  const report = reportCommand(["--outcome", "done", "--summary", "  answer\u001b  "], agentCtx);
  const first = readReport(dir);
  agentHook(dir, { hook_event_name: "UserPromptSubmit", session_id: "native-id" });
  const working = readReport(dir);
  agentHook(dir, { hook_event_name: "PermissionRequest", message: "Choose?" });
  const waiting = readReport(dir);
  agentHook(dir, { hook_event_name: "Stop", last_assistant_message: "Structured answer 😀" });
  const ended = readReport(dir);
  const forbidden = reportCommand(["--outcome", "done", "--summary", "bad"], { ...agentCtx, env: { ...agentCtx.env, PACER_REPORT_TOKEN: "wrong" } });
  const staleDir = join(ctx.pacerHome, "runs", sessionId, "1");
  mkdirSync(staleDir);
  const stale = reportCommand(["--outcome", "done", "--summary", "bad"], { ...agentCtx, env: { ...agentCtx.env, PACER_RUN_DIR: staleDir } });
  const user = reportCommand(["--task", sessionId, "--status", "done", "--summary", "user answer"], ctx);
  const outside = reportCommand([sessionId, "--status", "done", "--summary", "implicit"], ctx);
  const headless = tmpDir();
  writeReport(headless, "done", "first");
  agentHook(headless, { hook_event_name: "UserPromptSubmit" });
  writeReport(headless, "failed", "late failure");
  const reportView = (r: ReturnType<typeof readReport>) => r && { status: r.status, summary: r.summary, source: r.source ?? null };
  golden("report-handoff", { report, first: reportView(first), working: reportView(working), waiting: reportView(waiting), ended: reportView(ended),
    forbidden, stale, user, outside, headless: reportView(readReport(headless)),
    identity: readFileSync(join(dir, "agent-session-id"), "utf8"), transcript: readFileSync(join(dir, "transcript-report.md"), "utf8"),
    fileModes: ["agent-session-id", "transcript-report.md", "session-status.json", "events.jsonl"].map(name => [name, statSync(join(dir, name)).mode & 0o777]) });
});

test("messaging handoff keeps resume turns, replay prompts, idempotency, reads and planner hooks", async () => {
  const ctx = configured();
  ctx.env = { PACER_PLANNER_SESSION: "claude-code:s1" };
  const task = createTask(ctx, { brief: { goal: "original goal", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => {
    t.origin = "external:claude-code:s1"; t.state = "done";
    t.run = { dir: tmpDir(), attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: tmpDir(), logFile: "/dev/null", agentSession: { id: "native-id", source: "header" } };
    t.attempts = [{ executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "first report", backend: "direct" };
  });
  let spawns = 0;
  const deps = { spawnRunner: () => { spawns++; return 1; }, participant: "human" };
  const send = { to: `task:${task.id}`, body: "\ufeff  also handle 😀  \u00a0", request_id: "followup" };
  const sent = await callOp(ctx, "msg.send", send, deps) as any;
  const duplicate = await callOp(ctx, "msg.send", send, deps) as any;
  const mismatch = await outcome(() => callOp(ctx, "msg.send", { ...send, body: "changed" }, deps));
  const queued = readTask(ctx, task.id)!;
  const claim = claimTurnMessages(ctx, queued)!;
  const prompt = renderTurnPrompt(ctx, queued, claim.messages);
  updateTask(ctx, task.id, t => { t.state = "done"; t.attempts.push({ ...t.attempts[0]!, startedAt: 3, endedAt: 4 }); t.result = { ...t.result!, report: "second report" }; });
  await onRunEnded(ctx, task.id);
  await onRunEnded(ctx, task.id);
  const reports = messages.inbox(ctx, "external:claude-code:s1");
  const input = { session_id: "s1" };
  const promptHookOutput = await promptHook(ctx, "claude-code", input);
  const blocks = [await stopHook(ctx, "claude-code", input), await stopHook(ctx, "claude-code", input), await stopHook(ctx, "claude-code", input)];
  const executorHook = await stopHook({ ...ctx, env: { PACER_ROLE: "executor" } }, "claude-code", input);
  const inbox = await callOp(ctx, "msg.inbox", {}, { participant: "external:claude-code:s1" });
  const wait = await callOp(ctx, "msg.wait", { timeout_s: 1 }, { participant: "external:claude-code:s1" });
  const readInbox = await callOp(ctx, "msg.inbox", {}, { participant: "external:claude-code:s1" });
  const ids: [string, string][] = [[task.id, "$TASK"], [sent.message.id, "$MESSAGE"], ...reports.map((m, i) => [m.id, `$REPORT${i}`] as [string, string])];
  const projectMessage = (m: any) => ({ body: m.body, kind: m.kind, status: m.status });
  const viewInbox = (r: any) => ({ participant: r.participant, messages: r.messages.map(projectMessage), ...(r.timedOut === undefined ? {} : { timedOut: r.timedOut }) });
  golden("messaging-handoff", normalized({ sent: { duplicate: sent.duplicate, delivery: sent.delivery, message: projectMessage(sent.message) },
    duplicate: { duplicate: duplicate.duplicate, delivery: duplicate.delivery }, mismatch, spawns,
    queued: { state: queued.state, executor: queued.requestedExecutor, nativeId: queued.run?.agentSession?.id, pending: { executor: queued.pendingTurn?.executor, session: queued.pendingTurn?.session, replay: queued.pendingTurn?.replay } },
    prompt: { message: prompt.includes("also handle 😀"), original: prompt.includes("original goal") },
    reports: reports.map(projectMessage), promptHookOutput, blocks, executorHook, inbox: viewInbox(inbox), wait: viewInbox(wait), readInbox: viewInbox(readInbox),
    pendingAfterEnd: readTask(ctx, task.id)?.pendingTurn ?? null }, ids));
});

test("authenticated host terminals retain builtin target, request identity and noninteractive SSH argv", async () => {
  const ctx = configured();
  const calls: unknown[] = [];
  const result = await callOp(ctx, "host.terminal", { alias: "devbox", request_id: "00000000-0000-4000-8000-000000000002" }, {
    appAuthenticated: true,
    openTerminal: async (_ctx, options) => {
      calls.push(options);
      return { opened: true, target: "builtin", command: "fixture SSH", terminalId: "fixture-terminal" };
    },
  });
  golden("host-builtin", { result, calls });
});


test("messaging policy handoff holds pending messages or replays on the admitted executor", async () => {
  const results = [];
  for (const mode of ["held", "replay"] as const) {
    const f = policyGateFixture({ verdict: "allow" });
    writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"), JSON.stringify({ ...f.config, providers: { "claude-code": {}, codex: {}, cursor: {} } }));
    const task = createTask(f.ctx, { brief: { goal: "original goal", repo: f.repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
    updateTask(f.ctx, task.id, t => {
      t.origin = "human"; t.state = "done";
      t.run = { dir: tmpDir(), attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: f.repo, logFile: "/dev/null", agentSession: { id: "native-id", source: "header" } };
      t.attempts = [{ executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
      t.result = { status: "done", executor: "codex", model: null, files: "", report: "first report", backend: "direct" };
    });
    writeFileSync(join(f.dir, "settings.json"), JSON.stringify(mode === "held"
      ? { verdict: { verdict: "veto", reason: "repository frozen" }, delay: 0 }
      : { verdict: { verdict: "allow" }, delay: 0, byTask: { [task.id]: { verdict: "amend", amend: { exclude: ["codex"] } } } }));
    const earlier = messages.insertMessage(f.ctx, { taskId: task.id, rootId: `task:${task.id}`, from: `task:${task.id}`, to: "human",
      kind: "report", body: "earlier answer", replyTo: null, requestId: null }).message;
    messages.markRead(f.ctx, "human", [earlier.id]);
    const sent = await callOp(f.ctx, "msg.send", { to: `task:${task.id}`, body: "follow up" }, { appAuthenticated: true, spawnRunner: f.spawn }) as any;
    const current = readTask(f.ctx, task.id)!;
    const claim = mode === "replay" ? claimTurnMessages(f.ctx, current)! : null;
    const prompt = claim ? renderTurnPrompt(f.ctx, current, claim.messages) : "";
    const replayThread = claim ? renderReplayThread(f.ctx, current, claim.messages) : "";
    results.push({ mode, delivery: sent.delivery, hold: sent.hold ?? null, launches: f.launches(), state: current.state,
      priorResult: current.result?.report ?? null, pending: { executor: current.pendingTurn?.executor ?? null, session: current.pendingTurn?.session ?? null, replay: current.pendingTurn?.replay ?? false },
      unread: messages.pendingFor(f.ctx, `task:${task.id}`).map(m => m.body),
      decisions: f.calls().map(line => JSON.parse(line).decision),
      prompt: { original: prompt.includes("original goal"), message: prompt.includes("follow up") },
      replayThread: { prior: replayThread.includes("earlier answer"), current: replayThread.includes("follow up"), unavailable: replayThread.startsWith("Your earlier session for this task is unavailable.") } });
  }
  golden("messaging-policy-handoff", results);
});
