import { expect, test } from "bun:test";
import { preparePlannerInstall, type PreparedPlannerIO } from "../packages/plugin-sdk/src/install/prepared";
const env = { now: 1, pacerArgv: ["pacer"], plannerKey: "claude" };
const ok = { code: 0, stdout: "actual output", stderr: "" };
const io = (run: PreparedPlannerIO["run"]): PreparedPlannerIO => ({ read: async () => null, run });
test("real results control probes and preserve command note order and unique undo claims", async () => {
  const admitted: unknown[] = [];
  const plan = await preparePlannerInstall(io(async intent => {
    admitted.push(structuredClone(intent));
    if (intent.argv[0] === "get") return { code: 1, stdout: "missing", stderr: "" };
    if (intent.argv[0] === "bad") return { code: 2, stdout: "fallback\nsecond", stderr: "problem\nsecond" };
    if (intent.argv[0] === "throw") throw Error("spawn failed");
    return ok;
  }), env, undefined, async tx => {
    expect(await tx.runRaw(["get"])).toEqual({ code: 1, stdout: "missing", stderr: "" });
    await tx.run(["add"], ["remove"], { successNote: "added" });
    await tx.run(["bad"], ["remove"]);
    await tx.run(["throw"], ["undo-throw"]);
    await tx.run(["bad"], undefined, { quiet: true });
    tx.notes.push("Pipe note");
  });
  expect(plan.notes).toEqual(["added", "`bad` failed (exit 2): problem", "`throw` failed: spawn failed", "Pipe note"]);
  expect(plan.record.notes).toEqual(plan.notes);
  expect(plan.record.commands).toEqual([{ undo: ["remove"] }, { undo: ["undo-throw"] }]);
  expect(admitted[1]).toEqual({ argv: ["add"], undo: ["remove"], timeoutMs: 30000 });
});
test("raw probe/remove preserve real status and throw precedence", async () => {
  for (const get of [0, 1, "throw"] as const) for (const remove of [0, 1, "throw"] as const) {
    const calls: string[] = [];
    const plan = await preparePlannerInstall(io(async ({ argv }) => {
      calls.push(argv[0]!); const status = argv[0] === "get" ? get : remove;
      if (status === "throw") throw Error("offline");
      return { ...ok, code: status };
    }), env, undefined, async tx => {
      try {
        if ((await tx.runRaw(["get"])).code === 0) {
          const result = await tx.runRaw(["remove"]);
          tx.notes.push(result.code === 0 ? "removed" : "remove failed");
        }
      } catch { tx.notes.push("not installed"); }
    });
    expect(calls).toEqual(get === 0 ? ["get", "remove"] : ["get"]);
    expect(plan.notes).toEqual(get === "throw" || get === 0 && remove === "throw" ? ["not installed"] : get === 0 ? [remove === 0 ? "removed" : "remove failed"] : []);
  }
});
test("queued command metadata and final file/record snapshots are detached", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const intents: unknown[] = []; let captured: any;
  const work = preparePlannerInstall(io(async intent => { intents.push(structuredClone(intent)); if (intent.argv[0] === "wait") await gate; return ok; }), env, undefined, async tx => {
    captured = tx;
    const first = tx.run(["wait"]);
    const argv = ["add"], undo = ["remove"], options = { successNote: "original" };
    const second = tx.run(argv, undo, options);
    argv[0] = "changed"; undo[0] = "changed"; options.successNote = "changed";
    release(); await Promise.all([first, second]); await tx.edit("/file", () => "bytes", []);
  });
  const plan = await work;
  expect(intents[1]).toEqual({ argv: ["add"], undo: ["remove"], timeoutMs: 30000 });
  captured.record.commands[0].undo[0] = "mutated"; captured.pending.get("/file").after = "mutated"; captured.notes.push("late");
  expect(plan.files[0]!.after).toBe("bytes"); expect(plan.record.commands[0]!.undo).toEqual(["remove"]); expect(plan.notes).toEqual(["original"]);
  await expect(captured.run(["late"])).rejects.toThrow("closed");
});
test("caught staging failure rejects preparation after admitted commands", async () => {
  const admitted: string[] = [];
  await expect(preparePlannerInstall({ read: async () => { throw Error("read denied"); }, run: async intent => { admitted.push(intent.argv[0]!); return ok; } }, env, undefined, async tx => {
    await tx.run(["add"], ["remove"]);
    try { await tx.edit("/file", () => "new", []); } catch { /* retained failure */ }
  })).rejects.toThrow("read denied");
  expect(admitted).toEqual(["add"]);
});
test("reconcile rejects both command helpers even when callback catches denial", async () => {
  let calls = 0;
  await expect(preparePlannerInstall(io(async () => { calls++; return ok; }), { ...env, mode: "reconcile" }, undefined, async tx => {
    await expect(tx.run(["add"])).rejects.toThrow("cannot execute");
    await expect(tx.runRaw(["get"])).rejects.toThrow("cannot execute");
  })).rejects.toThrow("cannot execute");
  expect(calls).toBe(0);
});
test("missing or mismatched planner bindings fail before command admission", async () => {
  let calls = 0;
  const backend = io(async () => { calls++; return ok; });
  await expect(preparePlannerInstall(backend, { now: 1, pacerArgv: ["pacer"] }, undefined, tx => tx.run(["add"]))).rejects.toThrow("identity missing");
  await expect(preparePlannerInstall(backend, env, { planner: "other", installedAt: 1, pacerArgv: [], files: [], commands: [], notes: [] }, tx => tx.run(["add"]))).rejects.toThrow("identity mismatch");
  expect(calls).toBe(0);
});
test("parent sees detached undo before forward work and callback failure drains admitted commands", async () => {
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished = false, rejected = false;
  const undo = ["remove"];
  const work = preparePlannerInstall(io(async intent => {
    expect(intent.undo).toEqual(["remove"]);
    entered(); await gate; finished = true; return ok;
  }), env, undefined, async tx => {
    void tx.run(["add"], undo); undo[0] = "mutated";
    await started; throw Error("callback failure");
  });
  const observed = work.catch(error => { rejected = true; throw error; });
  await started; await Promise.resolve(); expect(rejected).toBe(false);
  release(); await expect(observed).rejects.toThrow("callback failure"); expect(finished).toBe(true);
});
test("raw commands with undo retain compensation claims on result and throw", async () => {
  const plan = await preparePlannerInstall(io(async ({ argv }) => {
    if (argv[0] === "throw") throw Error("spawn");
    return { ...ok, code: 3 };
  }), env, undefined, async tx => {
    await tx.runRaw(["bad"], ["undo"]);
    try { await tx.runRaw(["throw"], ["undo-throw"]); } catch { /* caller owns notes */ }
  });
  expect(plan.record.commands).toEqual([{ undo: ["undo"] }, { undo: ["undo-throw"] }]);
});
test("callback-started preparation cannot bypass command drain on callback failure", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let drained = false, rejected = false;
  let callbackPreparation!: Promise<unknown>;
  const work = preparePlannerInstall(io(async () => {
    entered(); await gate; drained = true; return ok;
  }), env, undefined, async tx => {
    void tx.run(["add"], ["remove"]);
    await started;
    callbackPreparation = tx.prepare();
    throw Error("callback failed after prepare");
  });
  const observed = work.catch(error => { rejected = true; return error; });
  await started;
  // Let callback failure and its terminal-drain continuation propagate fully.
  await new Promise(resolve => setTimeout(resolve, 0));
  const rejectedBeforeDrain = rejected;
  release();
  const failure = await observed;
  await callbackPreparation;
  expect(rejectedBeforeDrain).toBe(false);
  expect(drained).toBe(true);
  expect(failure.message).toBe("callback failed after prepare");
});
test("concurrent preparation joins deferred staging and command on normal callback return", async () => {
  let releaseRead!: () => void, releaseRun!: () => void;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const runGate = new Promise<void>(resolve => { releaseRun = resolve; });
  let snapshots!: ReturnType<import("../packages/plugin-sdk/src/install/prepared").PreparedPlannerBuilder["prepare"]>[];
  const work = preparePlannerInstall({
    read: async () => { await readGate; return null; },
    run: async () => { await runGate; return ok; },
  }, env, undefined, tx => {
    void tx.edit("/joined", () => "joined bytes", []);
    void tx.run(["add"], ["remove"]);
    snapshots = [tx.prepare(), tx.prepare()];
  });
  let settled = false;
  const observed = work.then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false);
  releaseRead(); await new Promise(resolve => setTimeout(resolve, 0)); expect(settled).toBe(false);
  releaseRun();
  const result = await observed;
  const [first, second] = await Promise.all(snapshots);
  expect(first).toEqual(result); expect(second).toEqual(result);
  first!.record.commands[0]!.undo[0] = "mutated";
  expect(second!.record.commands[0]!.undo).toEqual(["remove"]);
  expect(result.files).toEqual([{ path: "/joined", before: null, after: "joined bytes", beforeMode: undefined }]);
});
test("cancellation rejects before command admission and drains already admitted commands", async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await expect(preparePlannerInstall({ ...io(async () => { calls++; return ok; }), signal: before.signal }, env, undefined, tx => tx.run(["denied"]))).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
  const after = new AbortController(); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let drained = false;
  const work = preparePlannerInstall({ ...io(async () => { entered(); await gate; drained = true; return ok; }), signal: after.signal }, env, undefined, async tx => {
    void tx.run(["admitted"], ["undo"]); await started; after.abort();
  });
  let rejected = false;
  const observed = work.catch(error => { rejected = true; return error; });
  await started; await new Promise(resolve => setTimeout(resolve, 0)); expect(rejected).toBe(false);
  release(); expect((await observed).message).toContain("cancelled"); expect(drained).toBe(true);
});
test("mutated planner identity rejects the final candidate", async () => {
  await expect(preparePlannerInstall(io(async () => ok), env, undefined, tx => {
    tx.record.planner = "other";
  })).rejects.toThrow("identity mismatch");
});
