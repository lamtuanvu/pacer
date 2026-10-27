import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderCfg, loadStrategy } from "../src/config/strategy";
import { resumeOwnedDirect, runOwnedDirectCurrent, runOwnedDirectNew } from "../src/plugins/executor-production";
import { pluginRegistry } from "../src/plugins";
import { issueOwnedWorktreeGrant } from "../src/plugins/executor-worktree";
import { createCallAuthority } from "../src/plugins/authority";
import { answerCapability } from "../src/plugins/host";
import { answerDetachedStop } from "../src/plugins/capability-detached-stop";
import { manifest as directManifest } from "../plugins/pacer-exec-direct/manifest";
import { manifestSchema } from "../src/plugins/protocol";

const parsedDirectManifest = manifestSchema.parse(directManifest);
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { superviseTask, taskStop } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { registerWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { retryWork } from "../src/core/work";
import { realRun } from "./helpers";
import { eligibility } from "./fixtures/eligibility";
import { defaultHooks } from "../src/classify/hooks";
import { writeReport } from "../src/session/reports";
import { inspectOwnedExecutorRun } from "../src/plugins/executor-run-state";
import { fakeCtx } from "./helpers";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pacer-direct-current-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo"), bin = join(home, "bin");
  mkdirSync(pacerHome, { mode: 0o700 });
  mkdirSync(repo, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current}\n", { mode: 0o600 });
  const executable = join(bin, "codex");
  writeFileSync(executable, "#!/bin/sh\nprintf 'owned provider result\\n'\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${process.env.PATH}` },
    which: name => name === "codex" ? executable : null });
  const created = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 30, placement: { requested: "current" } });
  const task = updateTask(ctx, created.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
  });
  const cfg = loadStrategy(ctx).providers.codex as ProviderCfg;
  return { ctx, task, cfg, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("bundled direct provider owns a real current checkout wrapper and full outcome", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const out = await runOwnedDirectCurrent(ctx, cfg, task);
    expect(out.exec.code).toBe(0);
    expect(out.report).toContain("owned provider result");
    expect(out.attempt.executor).toBe("codex");
    expect(readTask(ctx, task.id)?.run?.mode).toBe("current");
    expect(readTask(ctx, task.id)?.startIntent).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct" });
    expect(readTask(ctx, task.id)?.executorExitReceipt).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct", exitCode: 0 });
  } finally { cleanup(); }
});

test("local interactive owner preserves the session files and fails a wrapper exit without report", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nexit 0\n",
    { mode: 0o700 });
  try {
    const out = await runOwnedDirectCurrent({ ...ctx, run: realRun },
      { ...cfg, session: "interactive" }, task);
    expect(out.exec.code).toBe(1);
    const run = readTask(ctx, task.id)!.run!;
    expect(run.session).toBe("interactive");
    expect(existsSync(join(run.dir, "interactive.json"))).toBe(true);
    expect(existsSync(join(run.dir, "session.json"))).toBe(true);
    expect(existsSync(join(run.dir, "report-hook.sh"))).toBe(true);
    expect(out.report).toContain("without an explicit completion report");
  } finally { cleanup(); }
});

test("local conversation launches through the owned provider and keeps native identity", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  const nativeId = "12345678-1234-1234-1234-123456789abc";
  writeFileSync(executable, `#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo '--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon'; exit 0; fi\nprintf '%s' '${nativeId}' > "$PACER_RUN_DIR/agent-session-id"\nsleep 1\n`, { mode: 0o700 });
  try {
    const current = updateTask(ctx, task.id, record => {
      record.interactionMode = "conversation";
      record.conversation = { activity: "starting" };
      record.placement = { requested: "current" };
    });
    const out = await runOwnedDirectCurrent({ ...ctx, run: realRun },
      { ...cfg, session: "interactive" }, current);
    expect(out.exec.code).toBe(0);
    const persisted = readTask(ctx, task.id)!;
    expect(persisted.run).toMatchObject({ interactionMode: "conversation", session: "interactive",
      agentSession: { id: nativeId } });
    expect(persisted.conversation?.agentSessionId).toBe(nativeId);
    expect(persisted.executorExitReceipt?.exitCode).toBe(0);
    const run = persisted.run!;
    const wrapperStart = Number(readFileSync(join(run.dir, "started"), "utf8"));
    const wrapperPid = Number(readFileSync(join(run.dir, "pid"), "utf8"));
    expect(run.wrapperStartedAt).toBe(wrapperStart);
    expect(run.wrapperPid).toBe(wrapperPid);
    expect(wrapperStart).toBeGreaterThan(run.startedAt);
    expect(run.startedAt).not.toBe(wrapperStart);
    writeFileSync(join(run.dir, "started"), String(wrapperStart + 1), { mode: 0o600 });
    expect(() => inspectOwnedExecutorRun(ctx, task.id, 1, true)).toThrow();
    writeFileSync(join(run.dir, "started"), String(wrapperStart), { mode: 0o600 });
    writeFileSync(join(run.dir, "pid"), String(wrapperPid + 1), { mode: 0o600 });
    expect(() => inspectOwnedExecutorRun(ctx, task.id, 1, true)).toThrow();
  } finally { cleanup(); }
});

test("local conversation waits beyond fifteen seconds for its first native ID without a second start", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon"; exit 0; fi\nsleep 16\nprintf "%s" "12345678-1234-1234-1234-123456789abc" > "$PACER_RUN_DIR/agent-session-id"\n', { mode: 0o700 });
  try {
    const current = updateTask(ctx, task.id, record => {
      record.interactionMode = "conversation";
      record.conversation = { activity: "starting" };
      record.placement = { requested: "current" };
    });
    const before = Date.now();
    const out = await runOwnedDirectCurrent({ ...ctx, run: realRun },
      { ...cfg, session: "interactive" }, current);
    expect(Date.now() - before).toBeGreaterThan(15_000);
    expect(out.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.run?.agentSession?.id)
      .toBe("12345678-1234-1234-1234-123456789abc");
    expect(readTask(ctx, task.id)?.attempts).toHaveLength(0);
  } finally { cleanup(); }
}, 30_000);

test("a conversation wrapper that exits without a native ID settles failed from the same run", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon"; exit 0; fi\nexit 0\n', { mode: 0o700 });
  try {
    const current = updateTask(ctx, task.id, record => {
      record.interactionMode = "conversation";
      record.conversation = { activity: "starting" };
      record.placement = { requested: "current" };
    });
    const out = await runOwnedDirectCurrent({ ...ctx, run: realRun },
      { ...cfg, session: "interactive" }, current);
    expect(out.exec.code).toBe(1);
    expect(out.report).toContain("native identity");
    expect(readTask(ctx, task.id)?.executorExitReceipt?.exitCode).toBe(0);
    expect(readTask(ctx, task.id)?.run?.agentSession).toBeUndefined();
  } finally { cleanup(); }
});

test("two conversation turn reports cannot settle the owned wrapper before recorded exit", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon"; exit 0; fi\nprintf "%s" "12345678-1234-1234-1234-123456789abc" > "$PACER_RUN_DIR/agent-session-id"\nfor i in $(seq 1 100); do [ -f "$PACER_RUN_DIR/allow-exit" ] && exit 0; sleep 0.1; done\nexit 7\n', { mode: 0o700 });
  let dir: string | undefined;
  let running: ReturnType<typeof runOwnedDirectCurrent> | undefined;
  try {
    const current = updateTask(ctx, task.id, record => {
      record.interactionMode = "conversation";
      record.conversation = { activity: "starting" };
      record.placement = { requested: "current" };
    });
    let result: string | undefined;
    running = runOwnedDirectCurrent({ ...ctx, run: realRun },
      { ...cfg, session: "interactive" }, current).then(value => {
        result = `success ${value.exec.code}`;
        return value;
      }, error => { result = `error ${String(error)}`; throw error; });
    for (let i = 0; i < 100 && !dir; i++) {
      dir = readTask(ctx, task.id)?.run?.dir;
      if (!dir) await Bun.sleep(20);
    }
    expect(dir).toBeDefined();
    writeReport(dir!, "done", "First turn");
    await Bun.sleep(300);
    expect(result).toBeUndefined();
    expect(readTask(ctx, task.id)?.executorExitReceipt).toBeUndefined();
    writeReport(dir!, "running", "Second turn");
    writeReport(dir!, "done", "Second turn complete");
    await Bun.sleep(300);
    expect(result).toBeUndefined();
    writeFileSync(join(dir!, "allow-exit"), "1", { mode: 0o600 });
    const out = await running;
    expect(out.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.executorReportReceipt).toBeUndefined();
  } finally {
    if (dir && existsSync(dir)) writeFileSync(join(dir, "allow-exit"), "1", { mode: 0o600 });
    await running?.catch(() => {});
    cleanup();
  }
});

test("task runner sends a local conversation through the owned provider", async () => {
  const { ctx, task, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon"; exit 0; fi\nprintf "%s" "12345678-1234-1234-1234-123456789abc" > "$PACER_RUN_DIR/agent-session-id"\nprintf "conversation turn complete\\n"\n', { mode: 0o700 });
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      delete current.executor;
      delete current.executorProvider;
      current.interactionMode = "conversation";
      current.conversation = { activity: "starting" };
      current.placement = { requested: "current" };
      current.timeoutS = 3600;
    });
    const deps = {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal" as const, disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const, windows: [],
          binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    };
    const result = await runTask({ ...ctx, run: realRun }, task.id, deps);
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.run?.interactionMode).toBe("conversation");
    expect(result.run?.agentSession?.id).toBe("12345678-1234-1234-1234-123456789abc");
    expect(result.attempts).toHaveLength(1);
    await pluginRegistry(ctx).disable(ctx, "pacer-exec-direct");
    const blocked = createTask(ctx, { brief: { goal: "second conversation", repo: task.brief.repo },
      kind: null, requestedExecutor: "codex", timeoutS: 30, placement: { requested: "current" },
      interactionMode: "conversation" });
    const denied = await runTask({ ...ctx, run: realRun }, blocked.id, deps);
    expect(denied.run).toBeUndefined();
    expect(denied.executorProvider).toBe("pacer-exec-direct");
  } finally { cleanup(); }
});

test("task runner owns a local Claude conversation with the exact assigned native ID", async () => {
  const { ctx, task, cleanup } = fixture();
  const claude = join(ctx.home, "bin", "claude");
  writeFileSync(claude, `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.281 (Claude Code)'; exit 0; fi
if [ "$1" = --help ]; then echo '--session-id --resume --add-dir --model --settings'; exit 0; fi
previous=''
for arg do
  if [ "$previous" = --session-id ]; then printf '%s' "$arg" > "$PACER_RUN_DIR/launch-session-id"; fi
  previous="$arg"
done
printf 'Claude conversation turn complete\\n'
`, { mode: 0o700 });
  ctx.which = name => name === "claude" ? claude : null;
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.requestedExecutor = "claude-code";
      delete current.executor;
      delete current.executorProvider;
      current.interactionMode = "conversation";
      current.conversation = { activity: "starting" };
      current.placement = { requested: "current" };
      current.timeoutS = 3600;
    });
    const deps = {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal" as const, disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    };
    const result = await runTask({ ...ctx, run: realRun }, task.id, deps);
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.run?.interactionMode).toBe("conversation");
    expect(result.run?.agentSession?.source).toBe("assigned");
    expect(result.run?.agentSession?.id).toBe(result.nativeIdentityIntent?.id);
    for (let i = 0; i < 100 && !existsSync(join(result.run!.dir, "launch-session-id")); i++)
      await Bun.sleep(20);
    expect(readFileSync(join(result.run!.dir, "launch-session-id"), "utf8"))
      .toBe(result.run!.agentSession!.id);
    expect(readTask(ctx, task.id)?.run?.agentSession?.id).toBe(result.run?.agentSession?.id);
    for (let i = 0; i < 100 && !existsSync(join(result.run!.dir, "exit")); i++)
      await Bun.sleep(20);
    let settled = await superviseTask(ctx, task.id, () => undefined);
    for (let i = 0; i < 50 && settled?.state === "running"; i++) {
      await Bun.sleep(20);
      settled = await superviseTask(ctx, task.id, () => undefined);
    }
    expect(settled?.state).toBe("done");
    await pluginRegistry(ctx).disable(ctx, "pacer-exec-direct");
    const blocked = createTask(ctx, { brief: { goal: "second Claude conversation", repo: task.brief.repo },
      kind: null, requestedExecutor: "claude-code", timeoutS: 3600, placement: { requested: "current" },
      interactionMode: "conversation" });
    const denied = await runTask({ ...ctx, run: realRun }, blocked.id, deps);
    expect(denied.run).toBeUndefined();
    expect(denied.executorProvider).toBe("pacer-exec-direct");
  } finally { cleanup(); }
});

test("task runner gives local OpenCode only its owned private reporting artifact", async () => {
  const { ctx, task, cleanup } = fixture();
  const opencode = join(ctx.home, "bin", "opencode");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, opencode: {via: opencode, model: test/model, usage: unmetered}}\nexecution: {worktree: current}\n");
  writeFileSync(opencode, `#!/bin/sh
if [ "$1" = --version ]; then echo 'opencode 2.1.2'; exit 0; fi
if [ "$1" = --help ]; then echo '--standalone --session --prompt'; exit 0; fi
if [ "$1" = api ] && [ "$2" = --help ]; then echo '--standalone'; exit 0; fi
if [ "$1" = api ]; then echo '{"data":{"id":"ses_owned"}}'; exit 0; fi
previous=''
for arg do
  if [ "$previous" = --session ]; then printf '%s' "$arg" > "$PACER_RUN_DIR/launch-session-id"; fi
  previous="$arg"
done
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$PACER_RUN_DIR/launch-config.json"
chmod 600 "$PACER_RUN_DIR/launch-config.json"
printf 'OpenCode conversation turn complete\\n'
`, { mode: 0o700 });
  ctx.which = name => name === "opencode" ? opencode : null;
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    ctx.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "test/model", plugins: ["existing-plugin"],
      provider: { fixture: { marker: "private-fixture" } } });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.requestedExecutor = "opencode#opencode";
      delete current.executor;
      delete current.executorProvider;
      current.interactionMode = "conversation";
      current.conversation = { activity: "starting" };
      current.placement = { requested: "current" };
      current.timeoutS = 3600;
    });
    const deps = {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal" as const, disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "opencode#opencode"].map(id => ({ id, eligibility: eligibility(),
          usage: "quota" as const, windows: [], binding: null, verdict: "ON_PACE" as const,
          installed: true, stale: false })), executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    };
    const result = await runTask({ ...ctx, run: realRun }, task.id, deps);
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.run?.agentSession?.id).toBe("ses_owned");
    expect(result.nativeIdentityIntent?.id).toBe("ses_owned");
    const dir = result.run!.dir;
    expect(readFileSync(join(dir, "launch-session-id"), "utf8")).toBe("ses_owned");
    expect(readFileSync(join(dir, "report-plugin", "index.ts"), "utf8")).toContain("ses_owned");
    const config = JSON.parse(readFileSync(join(dir, "launch-config.json"), "utf8"));
    expect(config).toMatchObject({ provider: { fixture: { marker: "private-fixture" } },
      plugins: ["existing-plugin", join(dir, "report-plugin")] });
    expect(readTask(ctx, task.id)?.attempts).toHaveLength(1);
    await pluginRegistry(ctx).disable(ctx, "pacer-agent-session");
    const blocked = createTask(ctx, { brief: { goal: "second OpenCode conversation", repo: task.brief.repo },
      kind: null, requestedExecutor: "opencode#opencode", timeoutS: 3600,
      placement: { requested: "current" }, interactionMode: "conversation" });
    const denied = await runTask({ ...ctx, run: realRun }, blocked.id, deps);
    expect(denied.run).toBeUndefined();
    expect(denied.executorProvider).toBe("pacer-exec-direct");
    expect(readTask(ctx, blocked.id)?.nativeIdentityIntent).toBeUndefined();
  } finally { cleanup(); }
});

test("malformed OpenCode account config refuses before native identity creation", async () => {
  const { ctx, task, cleanup } = fixture();
  const marker = join(ctx.home, "native-create-marker");
  const opencode = join(ctx.home, "bin", "opencode");
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, opencode: {via: opencode, model: test/model, usage: unmetered}}\nexecution: {worktree: current}\n");
  writeFileSync(opencode, `#!/bin/sh\nprintf native-create > ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  ctx.which = name => name === "opencode" ? opencode : null;
  ctx.env.OPENCODE_CONFIG_CONTENT = "[]";
  try {
    const cfg = Object.values(loadStrategy(ctx).providers).find(item => item.via === "opencode")!;
    const current = updateTask(ctx, task.id, record => {
      record.executor = cfg.id;
      record.interactionMode = "conversation";
      record.conversation = { activity: "starting" };
      record.placement = { requested: "current" };
    });
    await expect(runOwnedDirectCurrent({ ...ctx, run: realRun },
      { ...cfg, session: "interactive" }, current)).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    expect(readTask(ctx, task.id)?.nativeIdentityIntent).toBeUndefined();
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
  } finally { cleanup(); }
});

test("stopping an owned conversation does not label expected revocation lost-contact", async () => {
  const { ctx, task, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nif [ "$1" = --help ] || [ "$2" = --help ]; then echo "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon"; exit 0; fi\nprintf "%s" "12345678-1234-1234-1234-123456789abc" > "$PACER_RUN_DIR/agent-session-id"\nwhile :; do sleep 0.1; done\n', { mode: 0o700 });
  let running: ReturnType<typeof runTask> | undefined;
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      delete current.executor;
      delete current.executorProvider;
      current.interactionMode = "conversation";
      current.conversation = { activity: "starting" };
      current.placement = { requested: "current" };
      current.timeoutS = 3600;
    });
    running = runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const, windows: [],
          binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    for (let i = 0; i < 100 && !readTask(ctx, task.id)?.run?.agentSession; i++) await Bun.sleep(50);
    expect(readTask(ctx, task.id)?.run?.agentSession?.id)
      .toBe("12345678-1234-1234-1234-123456789abc");
    expect(taskStop(ctx, task.id)?.stopPending).toBeDefined();
    await running;
    expect(readTask(ctx, task.id)?.progress?.phase).not.toBe("lost-contact");
    let settled = await superviseTask(ctx, task.id, () => undefined);
    for (let i = 0; i < 20 && settled?.state === "running"; i++) {
      await Bun.sleep(50);
      settled = await superviseTask(ctx, task.id, () => undefined);
    }
    expect(settled?.state).toBe("stopped");
    expect(settled?.progress?.phase).not.toBe("lost-contact");
  } finally {
    if (readTask(ctx, task.id)?.state === "running") {
      taskStop(ctx, task.id);
      await superviseTask(ctx, task.id, () => undefined);
    }
    await running?.catch(() => {});
    cleanup();
  }
}, 15_000);

test("task runner routes an admitted current attempt through the bundled provider", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      delete current.executor;
      delete current.executorProvider;
    });
    const liveCtx = { ...ctx, run: realRun };
    const result = await runTask(liveCtx, task.id, {
      loadStrategy: loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const, windows: [],
          binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.attempts).toHaveLength(1);
    expect(result.result?.report).toContain("owned provider result");
  } finally { cleanup(); }
});

test("task runner selects the bundled provider for a local interactive session", async () => {
  const { ctx, task, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nexit 0\n",
    { mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "accounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nplanner: {agent: claude-code, account: claude}\nrunners:\n  codex: {agent: codex, account: codex, session: interactive}\nrouting:\n  - default: [codex]\nexecution: {worktree: current}\n",
    { mode: 0o600 });
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.run?.session).toBe("interactive");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.exitCode).toBe(1);
  } finally { cleanup(); }
});

test("supervision delivers a pending provider stop and settles only after wrapper exit", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const running = runOwnedDirectCurrent(ctx, cfg, task).catch(() => undefined);
  try {
    let current = readTask(ctx, task.id);
    for (let i = 0; i < 100 && !current?.startIntent; i++) {
      await Bun.sleep(20);
      current = readTask(ctx, task.id);
    }
    expect(current?.startIntent).toBeDefined();
    expect(taskStop(ctx, task.id)).toMatchObject({ state: "running", stopPending: { attempt: 1 } });
    let settled = await superviseTask(ctx, task.id, () => undefined);
    for (let i = 0; i < 20 && settled?.state === "running"; i++) {
      await Bun.sleep(50);
      settled = await superviseTask(ctx, task.id, () => undefined);
    }
    expect(settled?.state).toBe("stopped");
    expect(settled?.stopPending).toBeUndefined();
    expect(settled?.executorExitReceipt).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct" });
  } finally { await running; cleanup(); }
});

test("supervision stops an exact interactive session and records its wrapper exit", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable,
    "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n",
    { mode: 0o700 });
  const running = runOwnedDirectCurrent({ ...ctx, run: realRun },
    { ...cfg, session: "interactive" }, task).catch(() => undefined);
  try {
    let current = readTask(ctx, task.id);
    for (let i = 0; i < 100 && !current?.startIntent; i++) {
      await Bun.sleep(20);
      current = readTask(ctx, task.id);
    }
    expect(current?.run?.session).toBe("interactive");
    expect(existsSync(join(current!.run!.dir, "session.json"))).toBe(true);
    expect(taskStop(ctx, task.id)).toMatchObject({ state: "running", stopPending: { attempt: 1 } });
    const issued = readTask(ctx, task.id)!;
    const dir = issued.run!.dir, identity = statSync(dir);
    const wrongMode = createCallAuthority(ctx, { reads: [], commands: [], stores: [], detachedStop: {
      taskId: task.id, rev: issued.rev, attempt: 1, dir,
      dirIdentity: { dev: identity.dev, ino: identity.ino },
      pid: Number(readFileSync(join(dir, "pid"), "utf8")),
      startedAt: issued.run!.startedAt, executor: "codex", graceMs: 5000,
      stopIntent: { requestedAt: issued.stopPending!.requestedAt, providerId: "pacer-exec-direct" },
    } }, { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
    await expect(answerDetachedStop(wrongMode, { taskId: task.id, attempt: 1, graceMs: 5000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    await wrongMode.revoke();
    expect(existsSync(join(dir, "exit"))).toBe(false);
    let settled = await superviseTask(ctx, task.id, () => undefined);
    for (let i = 0; i < 20 && settled?.state === "running"; i++) {
      await Bun.sleep(50);
      settled = await superviseTask(ctx, task.id, () => undefined);
    }
    expect(settled?.state).toBe("stopped");
    expect(settled?.executorExitReceipt).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct", exitCode: 143 });
  } finally { await running; cleanup(); }
});

test("current owner refuses an explicitly new placement even under a current default", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    updateTask(ctx, task.id, current => { current.placement = { requested: "new" }; });
    expect(runOwnedDirectCurrent(ctx, cfg, readTask(ctx, task.id)!))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { cleanup(); }
});

test("current owner refuses a concurrently active task in the same checkout", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const other = createTask(ctx, { brief: { goal: "other", repo: task.brief.repo }, kind: null,
      requestedExecutor: "codex", timeoutS: 30 });
    updateTask(ctx, other.id, current => {
      current.state = "running";
      current.runnerPid = process.pid;
      current.placement = { requested: "current", mode: "current", why: "fixture" };
    });
    expect(runOwnedDirectCurrent(ctx, cfg, task))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { cleanup(); }
});

test("a broken owned wrapper settles without a built-in fallback attempt", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\necho 'error: unknown option --force' >&2\nexit 2\n",
      { mode: 0o700 });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.attempts).toHaveLength(1);
    expect(result.state).toBe("failed");
  } finally { cleanup(); }
});

test("bundled provider creates and owns an explicit head-based task worktree", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const out = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, selected);
    expect(out.exec.code).toBe(0);
    expect(out.worktree).toBe(readTask(ctx, task.id)?.worktree);
    expect(out.worktree).not.toBe(task.brief.repo);
    expect(readTask(ctx, task.id)?.run?.mode).toBe("new");
    expect(readTask(ctx, task.id)?.baseSha).toMatch(/^[0-9a-f]{40}$/);
  } finally { cleanup(); }
});

test("task runner completes an explicit new worktree through the bundled provider", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.result?.worktree).toBe(result.worktree);
    expect(result.worktree).not.toBe(task.brief.repo);
    expect(result.attempts).toHaveLength(1);
  } finally { cleanup(); }
});

test("lost provider reply reattaches to the exact wrapper without a second launch", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\nprintf x >> launch-count\nprintf 'resumed output\\n'\n",
      { mode: 0o700 });
    const registry = pluginRegistry(ctx);
    const lostReply = { call: async (...args: Parameters<typeof registry.call>) => {
      await registry.call(...args);
      throw Error("reply lost after provider completion");
    } };
    expect(runOwnedDirectCurrent(ctx, cfg, task, lostReply)).rejects.toThrow("reply lost");
    const persisted = readTask(ctx, task.id)!;
    expect(persisted.run).toBeDefined();
    expect(persisted.startIntent).toBeDefined();
    const recovered = await resumeOwnedDirect(ctx, cfg, persisted);
    expect(recovered.exec.code).toBe(0);
    expect(recovered.report).toContain("resumed output");
    expect(readFileSync(join(task.brief.repo, "launch-count"), "utf8")).toBe("x");
    expect(readTask(ctx, task.id)?.executorExitReceipt?.attempt).toBe(1);
  } finally { cleanup(); }
});

test("lost interactive completion reply recovers the same reported attempt", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nprintf x >> launch-count\nprintf '%s' '{\"status\":\"done\",\"summary\":\"owned done\",\"at\":101}' > \"$PACER_RUN_DIR/report.json\"\nsleep 30\n",
    { mode: 0o700 });
  const runtime = { ...ctx, run: realRun }, interactive = { ...cfg, session: "interactive" as const };
  const registry = pluginRegistry(runtime);
  const lostReply = { call: async (...args: Parameters<typeof registry.call>) => {
    await registry.call(...args);
    throw Error("interactive reply lost after completion");
  } };
  try {
    await expect(runOwnedDirectCurrent(runtime, interactive, task, lostReply))
      .rejects.toThrow("interactive reply lost after completion");
    const persisted = readTask(ctx, task.id)!;
    expect(persisted.executorReportReceipt).toMatchObject({ status: "done", attempt: 1 });
    const recovered = await resumeOwnedDirect(runtime, interactive, persisted);
    expect(recovered.exec.code).toBe(0);
    expect(recovered.report).toBe("owned done");
    expect(readFileSync(join(task.brief.repo, "launch-count"), "utf8")).toBe("x");
  } finally { cleanup(); }
});

test("a pending stop after interactive provider completion refuses success settlement", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  writeFileSync(ctx.which("codex")!,
    "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nprintf '%s' '{\"status\":\"done\",\"summary\":\"owned done\",\"at\":101}' > \"$PACER_RUN_DIR/report.json\"\nsleep 30\n",
    { mode: 0o700 });
  const runtime = { ...ctx, run: realRun }, registry = pluginRegistry(runtime);
  const stopAfterReply = { call: async (...args: Parameters<typeof registry.call>) => {
    const result = await registry.call(...args);
    updateTask(ctx, task.id, current => {
      current.stopPending = { attempt: 1, requestedAt: Date.now() / 1000,
        providerId: "pacer-exec-direct", graceMs: 5000 };
    });
    return result;
  } };
  try {
    await expect(runOwnedDirectCurrent(runtime, { ...cfg, session: "interactive" }, task,
      stopAfterReply)).rejects.toMatchObject({ code: "conflict" });
    expect(readTask(ctx, task.id)?.stopPending).toMatchObject({ attempt: 1 });
    expect(readTask(ctx, task.id)?.executorExitReceipt).toBeUndefined();
  } finally { cleanup(); }
});

test("task runner restart reconciles a lost provider result without relaunching", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\nprintf x >> launch-count\nprintf 'recovered task\\n'\n",
      { mode: 0o700 });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const registry = pluginRegistry(ctx);
    const lostReply = { call: async (...args: Parameters<typeof registry.call>) => {
      await registry.call(...args);
      throw Error("reply lost");
    } };
    expect(runOwnedDirectCurrent(ctx, cfg, task, lostReply)).rejects.toThrow("reply lost");
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.attempts).toHaveLength(1);
    expect(result.result?.report).toContain("recovered task");
    expect(readFileSync(join(task.brief.repo, "launch-count"), "utf8")).toBe("x");
  } finally { cleanup(); }
});

test("owned deadline persists a stop intent and settles failed only after wrapper exit", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n",
      { mode: 0o700 });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.timeoutS = 1;
      delete current.executor;
      delete current.executorProvider;
    });
    const running = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(running.state).toBe("running");
    expect(running.stopPending).toMatchObject({ attempt: 1, reason: "deadline" });
    let settled = await superviseTask(ctx, task.id, () => undefined);
    for (let i = 0; i < 20 && settled?.state === "running"; i++) {
      await Bun.sleep(50);
      settled = await superviseTask(ctx, task.id, () => undefined);
    }
    expect(settled?.state).toBe("failed");
    expect(settled?.attempts[0]?.timedOut).toBe(true);
  } finally { cleanup(); }
});

test("default new placement records origin-fetch intent before using the selected base", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const origin = join(ctx.home, "origin.git");
    Bun.spawnSync(["git", "init", "--bare", "-q", origin]);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "remote", "add", "origin", origin], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "push", "-q", "-u", "origin", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      delete current.brief.worktreeBase;
    });
    const out = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, selected);
    expect(out.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.baseFetchIntent).toMatchObject({
      attempt: 1, providerId: "pacer-exec-direct", base: "origin/main" });
    expect(readTask(ctx, task.id)?.baseSha).toBe(readTask(ctx, task.id)?.baseFetchIntent?.sha);
  } finally { cleanup(); }
});

test("default child placement in a local-only repo uses HEAD without a fetch", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      delete current.brief.worktreeBase;
    });
    const out = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, selected);
    expect(out.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.baseFetchIntent).toBeUndefined();
    expect(readTask(ctx, task.id)?.baseSha).toMatch(/^[0-9a-f]{40}$/);
  } finally { cleanup(); }
});

test("uncertain origin fetch retains intent and refuses a second fetch", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const origin = join(ctx.home, "origin.git");
    Bun.spawnSync(["git", "init", "--bare", "-q", origin]);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "remote", "add", "origin", origin], { cwd: task.brief.repo });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      delete current.brief.worktreeBase;
    });
    let fetches = 0;
    const uncertain = { ...ctx, run: async (...args: Parameters<typeof realRun>) => {
      if (args[0].includes("fetch")) {
        fetches++;
        return { code: 124, timedOut: true, stdout: "", stderr: "fixture timeout" };
      }
      return realRun(...args);
    } };
    expect(runOwnedDirectNew(uncertain, cfg, selected)).rejects.toMatchObject({ code: "conflict" });
    expect(readTask(ctx, task.id)?.baseFetchIntent).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct" });
    expect(runOwnedDirectNew(uncertain, cfg, readTask(ctx, task.id)!))
      .rejects.toMatchObject({ code: "conflict" });
    expect(fetches).toBe(1);
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
  } finally { cleanup(); }
});

test("default automatic child placement runs through the bundled provider", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: child-of-current}\n",
      { mode: 0o600 });
    const origin = join(ctx.home, "origin.git");
    Bun.spawnSync(["git", "init", "--bare", "-q", origin]);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "remote", "add", "origin", origin], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "push", "-q", "-u", "origin", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.placement = { requested: "auto" };
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => null },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.placement?.mode).toBe("new");
    expect(result.baseFetchIntent?.base).toBe("origin/main");
  } finally { cleanup(); }
});

test("disabled bundled executor refuses before a local process effect", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    await pluginRegistry(ctx).disable(ctx, "pacer-exec-direct");
    expect(runOwnedDirectCurrent(ctx, cfg, task)).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    expect(readTask(ctx, task.id)?.startIntent).toBeUndefined();
  } finally { cleanup(); }
});

test("retry reuses the prior task-owned worktree after its HEAD advances", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const first = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const initial = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, first);
    const worktree = initial.worktree!;
    writeFileSync(join(worktree, "first-commit.txt"), "retained\n");
    Bun.spawnSync(["git", "add", "first-commit.txt"], { cwd: worktree });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "-m", "task work"], { cwd: worktree });
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktree }).stdout.toString().trim();
    updateTask(ctx, task.id, current => {
      current.state = "done";
      current.result = { status: "done", executor: "codex", model: null, files: "first-commit.txt",
        report: "fixture", backend: "direct", worktree };
    });
    const retried = createTask(ctx, { brief: { goal: "retry", repo: task.brief.repo }, kind: null,
      requestedExecutor: "codex", timeoutS: 30 });
    const selected = updateTask(ctx, retried.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      current.retryOf = task.id;
      current.worktree = worktree;
      current.placement = { requested: "new" };
    });
    const outcome = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, selected);
    expect(outcome.worktree).toBe(worktree);
    expect(readTask(ctx, retried.id)?.baseSha).toBe(head);
    expect(readFileSync(join(worktree, "first-commit.txt"), "utf8")).toBe("retained\n");
  } finally { cleanup(); }
});

test("a managed retry keeps the same task worktree under a second provider-owned run", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    registerWork(ctx, task.id, { maxAttempts: 2 });
    const first = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const initial = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, first);
    const original = readTask(ctx, task.id)!;
    expect(original.run?.attempt).toBe(1);
    expect(original.worktree).toBe(initial.worktree);
    writeFileSync(join(initial.worktree!, "first-attempt.txt"), "retained across retry\n");
    Bun.spawnSync(["git", "add", "first-attempt.txt"], { cwd: initial.worktree });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "-m", "first attempt"], { cwd: initial.worktree });
    const advancedHead = Bun.spawnSync(["git", "rev-parse", "HEAD"],
      { cwd: initial.worktree }).stdout.toString().trim();
    updateTask(ctx, task.id, current => {
      current.attempts.push(initial.attempt);
      current.state = "failed";
      current.result = { status: "failed", executor: "codex", model: null, files: "",
        report: "fixture asks for another attempt", backend: "direct", worktree: initial.worktree };
    });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
      planner: "claude-code", accounts: { "claude-code": { kind: "claude" },
        codex: { kind: "codex", usage: "unmetered" } },
      runners: { codex: { models: [{ id: "provider/fixture", tier: "small" }] } },
      execution: { worktree: "new-child" },
      dispatch: { timeoutMs: 5000, steps: [{ id: "fixture", capacity: "unknown" }] },
    }));
    const liveCtx = { ...ctx, now: Date.now() / 1000, run: realRun };
    await retryWork(liveCtx, task.id,
      { expectRev: readTask(ctx, task.id)!.rev, requestId: "same-task-attempt-2" }, () => undefined);
    const selected = readTask(ctx, task.id)!;
    expect(selected.state).toBe("queued");
    expect(selected.worktree).toBe(initial.worktree);
    expect(selected.run).toBeUndefined();
    const status = async () => ({ generatedAt: Date.now() / 1000, strategy: "default", planner: "claude-code",
      mode: "normal" as const, disabled: false, calendarPace: true, accounts: [],
      providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
        windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
      executors: { ranked: [], excluded: [] } });
    const result = await runTask(liveCtx, task.id, {
      loadStrategy,
      computeStatus: status,
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.attempts).toHaveLength(2);
    expect(result.worktree).toBe(initial.worktree);
    expect(result.run?.attempt).toBe(2);
    expect(result.startIntent).toMatchObject({ attempt: 2, providerId: "pacer-exec-direct" });
    expect(result.executorExitReceipt).toMatchObject({ attempt: 2, providerId: "pacer-exec-direct" });
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.baseSha).toBe(advancedHead);
    expect(readFileSync(join(initial.worktree!, "first-attempt.txt"), "utf8"))
      .toBe("retained across retry\n");
  } finally { cleanup(); }
});

test("delegating managed work reaches only the owned executor child with its attempt grant", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\nif [ -n \"$PACER_WORK_GRANT\" ]; then echo grant-present; else echo grant-missing; fi\n", { mode: 0o700 });
    registerWork(ctx, task.id, { allowDelegation: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
      planner: "claude-code", accounts: { "claude-code": { kind: "claude" },
        codex: { kind: "codex", usage: "unmetered" } },
      runners: { codex: { models: [{ id: "provider/fixture", tier: "small" }] } },
      execution: { worktree: "new-child" },
      dispatch: { timeoutMs: 5000, steps: [{ id: "fixture", capacity: "unknown" }] },
    }));
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
      delete current.executor;
      delete current.executorProvider;
    });
    const liveCtx = { ...ctx, now: Date.now() / 1000, run: realRun };
    const result = await runTask(liveCtx, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: Date.now() / 1000, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.startIntent?.attempt).toBe(1);
    expect(result.result?.report).toContain("grant-present");
    expect(JSON.stringify(result)).not.toMatch(/pwg_[0-9a-f]{64}/);
    expect(readFileSync(result.run!.logFile, "utf8")).not.toMatch(/pwg_[0-9a-f]{64}/);
    const grants = dispatchDatabase(ctx).query<{ n: number; live: number }, [string]>(
      "SELECT count(*) AS n, sum(CASE WHEN revoked=0 THEN 1 ELSE 0 END) AS live FROM work_grants WHERE task_id=?",
    ).get(task.id)!;
    expect(grants.n).toBe(1);
    expect(grants.live).toBe(0);
  } finally { cleanup(); }
});

test("disabled bundled executor never falls back for delegating managed work", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const marker = join(task.brief.repo, "legacy-ran.txt");
    writeFileSync(ctx.which("codex")!, `#!/bin/sh\nprintf legacy > '${marker}'\n`, { mode: 0o700 });
    registerWork(ctx, task.id, { allowDelegation: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
      planner: "claude-code", accounts: { "claude-code": { kind: "claude" },
        codex: { kind: "codex", usage: "unmetered" } },
      runners: { codex: { models: [{ id: "provider/fixture", tier: "small" }] } },
      execution: { worktree: "new-child" },
      dispatch: { timeoutMs: 5000, steps: [{ id: "fixture", capacity: "unknown" }] },
    }));
    await pluginRegistry(ctx).disable(ctx, "pacer-exec-direct");
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, now: Date.now() / 1000, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: Date.now() / 1000, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).not.toBe("done");
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/pwg_[0-9a-f]{64}/);
    const grants = dispatchDatabase(ctx).query<{ live: number }, [string]>(
      "SELECT count(*) AS live FROM work_grants WHERE task_id=? AND revoked=0",
    ).get(task.id)!;
    expect(grants.live).toBe(0);
  } finally { cleanup(); }
});

test("an uncertain prior local attempt cannot launch a second provider run", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const first = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const initial = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, first);
    const uncertain = updateTask(ctx, task.id, current => {
      current.attempts.push(initial.attempt);
      delete current.run;
      delete current.executorExitReceipt;
    });
    expect(runOwnedDirectNew({ ...ctx, run: realRun }, cfg, uncertain))
      .rejects.toMatchObject({ code: "conflict" });
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    expect(readTask(ctx, task.id)?.startIntent?.attempt).toBe(1);
  } finally { cleanup(); }
});

test("a settled in-place attempt can claim a second provider run", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const first = await runOwnedDirectCurrent({ ...ctx, run: realRun }, cfg, task);
    const retry = updateTask(ctx, task.id, current => {
      current.attempts.push(first.attempt);
      delete current.run;
    });
    const second = await runOwnedDirectCurrent({ ...ctx, run: realRun }, cfg, retry);
    expect(second.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.run?.attempt).toBe(2);
    expect(readTask(ctx, task.id)?.startIntent?.attempt).toBe(2);
    expect(readTask(ctx, task.id)?.executorExitReceipt?.attempt).toBe(2);
  } finally { cleanup(); }
});

test("lost worktree effect reply recovers the exact placement before run claim", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const liveCtx = { ...ctx, run: realRun };
    const grant = await issueOwnedWorktreeGrant(liveCtx, task.id, "pacer-exec-direct", 1, "HEAD");
    const authority = createCallAuthority(liveCtx, { reads: [], commands: [], stores: [], worktree: grant },
      { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
    try {
      await answerCapability(liveCtx, { id: "pacer-exec-direct", manifest: parsedDirectManifest },
        "capability.worktree.createOrReuse", { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, authority);
    } finally { await authority.revoke(); }
    expect(readTask(ctx, task.id)?.worktreeIntent).toMatchObject({ path: grant.path, baseSha: grant.baseSha });
    const recovered = await runOwnedDirectNew(liveCtx, cfg, readTask(ctx, selected.id)!);
    expect(recovered.exec.code).toBe(0);
    expect(recovered.worktree).toBe(grant.workdir);
    expect(readTask(ctx, task.id)?.worktreeIntent).toBeUndefined();
    expect(readTask(ctx, task.id)?.run?.attempt).toBe(1);
  } finally { cleanup(); }
});

test("runner restart resumes a journaled worktree before any run was published", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.placement = { requested: "new", mode: "new", why: "fixture" };
      current.brief.worktreeBase = "head";
      current.attemptStartedAt = ctx.now;
      current.runnerPid = 999_999;
    });
    const liveCtx = { ...ctx, run: realRun };
    const grant = await issueOwnedWorktreeGrant(liveCtx, task.id, "pacer-exec-direct", 1, "HEAD");
    const authority = createCallAuthority(liveCtx, { reads: [], commands: [], stores: [], worktree: grant },
      { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
    try {
      await answerCapability(liveCtx, { id: "pacer-exec-direct", manifest: parsedDirectManifest },
        "capability.worktree.createOrReuse", { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, authority);
    } finally { await authority.revoke(); }
    const result = await runTask(liveCtx, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.attempts).toHaveLength(1);
    expect(result.worktree).toBe(grant.workdir);
  } finally { cleanup(); }
});
