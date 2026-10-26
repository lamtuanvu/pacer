import { expect, test } from "bun:test";
import { Txn, runInstall, type TransactionIO } from "../packages/plugin-sdk/src/install/txn";
import type { PlannerRecord } from "../packages/plugin-sdk/src/install/undo";
import type { PendingFile } from "../packages/plugin-sdk/src/install/plan";

const env = { now: 1700000000, pacerArgv: ["pacer"] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function memory(signal?: AbortSignal) {
  const files = new Map<string, string>(), commands: string[][] = [], events: string[] = [];
  const records = new Map<string, PlannerRecord>();
  const committed: { planner: string; record: PlannerRecord; files: PendingFile[] }[] = [];
  const io: TransactionIO = {
    signal,
    read: async path => files.has(path) ? { text: files.get(path)!, mode: 0o600 } : null,
    recover: async () => { events.push("recover"); },
    readRecord: async planner => { events.push("record"); return records.get(planner); },
    run: async argv => { commands.push([...argv]); return { code: 0, stdout: "", stderr: "" }; },
    commit: async (planner, record, changes) => {
      committed.push({ planner, record, files: changes });
      for (const file of changes) if (file.after === null) files.delete(file.path); else files.set(file.path, file.after);
      records.set(planner, record);
    },
  };
  return { io, files, records, commands, events, committed };
}
// Missing drain would commit before the deferred read and lose the staged edit.
test("commit drains unawaited staging and preserves other host planner records", async () => {
  const f = memory(), gate = deferred();
  const other = { planner: "other", installedAt: 1, pacerArgv: [], files: [], commands: [], notes: [] };
  f.records.set("other", other);
  f.io.read = async () => { await gate.promise; return null; };
  const result = runInstall(f.io, env, "codex", tx => { void tx.edit("/new", () => "new", []); });
  await Promise.resolve(); await Promise.resolve();
  expect(f.committed).toEqual([]);
  gate.resolve();
  const report = await result;
  expect(f.files.get("/new")).toBe("new"); expect(report.touched).toEqual(["/new"]);
  expect(f.events).toEqual(["recover", "record"]); expect(f.records.get("other")).toBe(other);
});
// Swallowing staging rejection in the sequencing tail must not allow a partial commit.
test("caught staging failure still rejects settlement and discards pending changes", async () => {
  const f = memory(); let tx!: Txn;
  await expect(runInstall(f.io, env, "codex", async value => {
    tx = value;
    await tx.edit("/good", () => "good", []);
    await tx.edit("/bad", () => { throw Error("bad data"); }, []).catch(() => {});
  })).rejects.toThrow("bad data");
  expect(f.committed).toEqual([]); expect(tx.pending.size).toBe(0); expect(f.files.size).toBe(0);
});
// Undo is required even for failed/throwing commands, deduped and reversed once.
test("run preserves notes, quiet and success semantics and rolls back unique undos in reverse", async () => {
  const f = memory(); let calls = 0;
  f.io.run = async (argv, timeout, configEnv) => {
    f.commands.push([...argv]); expect(timeout).toBe(30000); expect(configEnv).toEqual({ CODEX_HOME: "/fixture" });
    calls++;
    if (calls === 1) return { code: 2, stderr: "first\nsecond", stdout: "fallback" };
    if (calls === 2) throw Error("offline");
    if (calls === 5) throw Error("undo unavailable");
    return { code: 0, stdout: "", stderr: "" };
  };
  const tx = new Txn(f.io, { ...env, configEnv: { CODEX_HOME: "/fixture" } }, "codex");
  await tx.run(["agent", "a b"], ["undo", "one"]);
  await tx.run(["agent", "quiet"], ["undo", "one"], { quiet: true });
  await tx.run(["agent", "ok"], ["undo", "two"], { successNote: "ready" });
  await tx.edit("/new", () => "new", []);
  await tx.rollback(); await tx.rollback();
  expect(f.commands).toEqual([["agent", "a b"], ["agent", "quiet"], ["agent", "ok"], ["undo", "two"], ["undo", "one"]]);
  expect(tx.record.commands).toEqual([{ undo: ["undo", "one"] }, { undo: ["undo", "two"] }]);
  expect(tx.notes).toEqual(["`agent 'a b'` failed (exit 2): first", "ready", "rollback command failed: Error: undo unavailable"]);
  expect(tx.pending.size).toBe(0);
});
test("reconcile refuses commands before admission and preserves prior mcp", async () => {
  const f = memory();
  const prior: PlannerRecord = { planner: "codex", installedAt: 1, pacerArgv: [], files: [], commands: [], notes: [], mcp: true };
  const tx = new Txn(f.io, { ...env, mode: "reconcile", mcp: false }, "codex", prior);
  await expect(tx.run(["agent"], ["undo"])).rejects.toThrow("automatic refresh cannot execute agent commands");
  expect(f.commands).toEqual([]); expect(tx.record.commands).toEqual([]); expect(tx.record.mcp).toBe(true);
});
test("command arguments, undo, config and options are snapshotted before awaiting backend", async () => {
  const f = memory(), gate = deferred(), started = deferred();
  let observed: unknown;
  f.io.run = async (argv, timeout, config) => {
    started.resolve(); await gate.promise; observed = { argv, timeout, config };
    return { code: 0, stdout: "", stderr: "" };
  };
  const input = { ...env, configEnv: { CODEX_HOME: "/before" } }, argv = ["agent", "before"], undo = ["undo", "before"], options = { successNote: "before" };
  const tx = new Txn(f.io, input, "codex");
  const running = tx.run(argv, undo, options); await started.promise;
  argv[1] = "after"; undo[1] = "after"; input.configEnv.CODEX_HOME = "/after"; options.successNote = "after";
  gate.resolve(); await running;
  expect(observed).toEqual({ argv: ["agent", "before"], timeout: 30000, config: { CODEX_HOME: "/before" } });
  expect(tx.record.commands).toEqual([{ undo: ["undo", "before"] }]); expect(tx.notes).toEqual(["before"]);
});
test("commit snapshots record/files across backend await and refuses repeated settlement", async () => {
  const f = memory(), gate = deferred(), started = deferred();
  f.io.commit = async (planner, record, files) => { started.resolve(); await gate.promise; f.committed.push({ planner, record, files }); };
  const tx = new Txn(f.io, env, "codex");
  await tx.edit("/new", () => "before", []); tx.notes.push("before");
  const committing = tx.commit(); await started.promise;
  tx.record.pacerArgv.push("after"); tx.notes.push("after"); tx.pending.get("/new")!.after = "after";
  gate.resolve(); await committing;
  expect(f.committed[0]!.record.pacerArgv).toEqual(["pacer"]); expect(f.committed[0]!.record.notes).toEqual(["before"]);
  expect(f.committed[0]!.files).toEqual([{ path: "/new", before: null, after: "before", beforeMode: undefined }]);
  await expect(tx.commit()).rejects.toThrow("settled");
  await expect(tx.edit("/late", () => "late", [])).rejects.toThrow("closed");
});
test("cancellation prevents planning but cannot abandon admitted command undo on failure", async () => {
  const controller = new AbortController(), f = memory(controller.signal), gate = deferred(), started = deferred();
  f.io.run = async argv => { f.commands.push([...argv]); if (argv[0] === "agent") { started.resolve(); await gate.promise; } return { code: 0, stdout: "", stderr: "" }; };
  const result = runInstall(f.io, env, "codex", tx => { void tx.run(["agent"], ["undo"]); });
  await started.promise; controller.abort(); expect(f.commands).toEqual([["agent"]]); gate.resolve();
  await expect(result).rejects.toThrow("cancelled"); expect(f.commands).toEqual([["agent"], ["undo"]]); expect(f.committed).toEqual([]);
});
test("cancellation after commit admission does not abandon settlement", async () => {
  const controller = new AbortController(), f = memory(controller.signal), gate = deferred(), started = deferred();
  f.io.commit = async (planner, record, files) => { started.resolve(); await gate.promise; f.committed.push({ planner, record, files }); };
  const result = runInstall(f.io, env, "codex", tx => tx.edit("/new", () => "new", []).then(() => {}));
  await started.promise; controller.abort(); gate.resolve();
  expect((await result).record.planner).toBe("codex"); expect(f.committed).toHaveLength(1);
});
test("backend commit failure awaits rollback before surfacing original error", async () => {
  const f = memory(), error = Error("commit failed"), undoGate = deferred(), undoStarted = deferred(); let finished = false;
  f.io.commit = async () => { throw error; };
  f.io.run = async argv => { f.commands.push([...argv]); if (argv[0] === "undo") { undoStarted.resolve(); await undoGate.promise; } return { code: 0, stdout: "", stderr: "" }; };
  const result = runInstall(f.io, env, "codex", async tx => { await tx.run(["agent"], ["undo"]); await tx.edit("/new", () => "new", []); });
  const checked = result.catch(err => { finished = true; throw err; });
  await undoStarted.promise; expect(finished).toBe(false); undoGate.resolve();
  await expect(checked).rejects.toBe(error); expect(f.commands).toEqual([["agent"], ["undo"]]); expect(f.files.size).toBe(0);
});
test("bound planner identity cannot be reassigned through mutable record metadata", async () => {
  const f = memory();
  await expect(runInstall(f.io, { ...env, plannerKey: "bound" }, "codex", tx => { tx.record.planner = "other"; })).rejects.toThrow("planner identity");
  expect(f.committed).toEqual([]);
});
// Rolling back while backend commit awaits must not undo effects that commit wins.
test("concurrent rollback waits for admitted commit settlement", async () => {
  const f = memory(), gate = deferred(), started = deferred();
  f.io.commit = async () => { started.resolve(); await gate.promise; };
  const tx = new Txn(f.io, env, "codex");
  await tx.run(["agent"], ["undo"]);
  const committing = tx.commit(); await started.promise;
  const rollingBack = tx.rollback();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(f.commands).toEqual([["agent"]]);
  gate.resolve(); await Promise.all([committing, rollingBack]);
  expect(f.commands).toEqual([["agent"]]);
});
test("callback failure waits for unawaited commands and rolls back without committing", async () => {
  const f = memory(), gate = deferred(), started = deferred(), error = Error("callback failed");
  f.io.run = async argv => { f.commands.push([...argv]); if (argv[0] === "agent") { started.resolve(); await gate.promise; } return { code: 0, stdout: "", stderr: "" }; };
  const result = runInstall(f.io, env, "codex", async tx => { void tx.run(["agent"], ["undo"]); await started.promise; throw error; });
  await started.promise; gate.resolve();
  await expect(result).rejects.toBe(error); expect(f.commands).toEqual([["agent"], ["undo"]]); expect(f.committed).toEqual([]);
});
test("nonquiet command throws and stdout failure fallback retain legacy notes", async () => {
  const f = memory(); let call = 0;
  f.io.run = async () => { if (++call === 1) throw Error("offline"); return { code: 3, stderr: "", stdout: "fallback\r\nsecond" }; };
  const tx = new Txn(f.io, env, "codex");
  await tx.run(["agent"]); await tx.run(["agent"], undefined, { successNote: "not ready" });
  expect(tx.notes).toEqual(["`agent` failed: offline", "`agent` failed (exit 3): fallback"]);
});
