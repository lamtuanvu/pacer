import { expect, test } from "bun:test";
import { handlers } from "../plugins/pacer-exec-direct/index";
import { executorAttemptOutcome } from "../src/plugins/executor-protocol";

const params = { task: { id: "t-fixture", rev: 2 }, attempt: 1, runDir: 1,
  owned: { placement: "current", timeoutMs: 5000, executor: "codex", model: null } };

test("provider owns claim, start, bounded polls and full local outcome without a direct process call", async () => {
  const methods: string[] = [];
  let polls = 0;
  const host = { call: async (method: string) => {
    methods.push(method);
    if (method === "capability.process.claimRun") return { task: { id: "t-fixture", rev: 3 },
      attempt: 1, runDir: 1, dir: "/tmp/owned/1", workdir: "/tmp/repo",
      startedAt: 100, logFile: "/tmp/owned/1/stdout" };
    if (method === "capability.process.startRun") return { pid: 42 };
    if (method === "capability.process.pollRun") return ++polls === 1
      ? { state: "running", exitCode: null } : { state: "exited", exitCode: 0 };
    if (method === "capability.process.readRunOutput") return {
      stdoutBase64: Buffer.from("fixture complete\n").toString("base64"), stderrBase64: "" };
    throw Error(`unexpected ${method}`);
  } };
  const result = await handlers["executor.run"](params, host as any, new AbortController().signal);
  expect(executorAttemptOutcome.safeParse(result).success).toBe(true);
  expect(result).toMatchObject({ backend: "direct", report: "fixture complete",
    attempt: { executor: "codex", exitCode: 0, limitHit: false }, exec: { code: 0 } });
  expect(methods).toEqual(["capability.process.claimRun", "capability.process.startRun",
    "capability.process.pollRun", "capability.process.pollRun", "capability.process.readRunOutput"]);
});

test("isolated provider requests fixed placement before any run claim", async () => {
  const methods: string[] = [];
  const host = { call: async (method: string) => {
    methods.push(method);
    if (method === "capability.worktree.resolveBase") return { base: "HEAD", sha: "a".repeat(40) };
    if (method === "capability.worktree.createOrReuse") return { workdir: "/tmp/owned-worktree" };
    if (method === "capability.process.claimRun") return { task: { id: "t-fixture", rev: 4 },
      attempt: 1, runDir: 1, dir: "/tmp/owned/1", workdir: "/tmp/owned-worktree",
      startedAt: 100, logFile: "/tmp/owned/1/stdout" };
    if (method === "capability.process.startRun") return { pid: 42 };
    if (method === "capability.process.pollRun") return { state: "exited", exitCode: 0 };
    if (method === "capability.process.readRunOutput") return { stdoutBase64: "", stderrBase64: "" };
    throw Error(`unexpected ${method}`);
  } };
  const result = await handlers["executor.run"]({ ...params, owned: { ...params.owned, placement: "new" } },
    host as any, new AbortController().signal);
  expect(result).toMatchObject({ worktree: "/tmp/owned-worktree" });
  expect(methods.slice(0, 4)).toEqual(["capability.worktree.resolveBase",
    "capability.worktree.createOrReuse", "capability.process.claimRun", "capability.process.startRun"]);
});

test("lost start receipt stays uncertain and does not trigger another start or direct fallback", async () => {
  const methods: string[] = [];
  const host = { call: async (method: string) => {
    methods.push(method);
    if (method === "capability.process.claimRun") return { task: { id: "t-fixture", rev: 3 },
      attempt: 1, runDir: 1, dir: "/tmp/owned/1", workdir: "/tmp/repo",
      startedAt: 100, logFile: "/tmp/owned/1/stdout" };
    throw Error("lost start receipt");
  } };
  await expect(handlers["executor.run"](params, host as any, new AbortController().signal))
    .rejects.toThrow("lost start receipt");
  expect(methods).toEqual(["capability.process.claimRun", "capability.process.startRun"]);
});

test("provider recovery reads the exact prior run without claiming or starting", async () => {
  const methods: string[] = [];
  const host = { call: async (method: string) => {
    methods.push(method);
    if (method === "capability.process.pollRun") return { state: "exited", exitCode: 0 };
    if (method === "capability.process.readRunOutput") return {
      stdoutBase64: Buffer.from("recovered\n").toString("base64"), stderrBase64: "" };
    throw Error(`unexpected ${method}`);
  } };
  const result = await handlers["executor.run"]({ ...params,
    owned: { ...params.owned, resume: { startedAt: 100, logFile: "/tmp/owned/1/stdout" } } },
    host as any, new AbortController().signal);
  expect(result).toMatchObject({ report: "recovered", attempt: { startedAt: 100 } });
  expect(methods).toEqual(["capability.process.pollRun", "capability.process.readRunOutput"]);
});

test("remote provider owns placement, claim, start, observation and full pipe outcome", async () => {
  const methods: string[] = [];
  const host = { call: async (method: string) => {
    methods.push(method);
    if (method === "capability.hosts.prepareOwned") return { worktree: "/home/x/worktree", branch: "pacer/t-fixture" };
    if (method === "capability.hosts.claimOwned") return { startedAt: 100, logFile: "/tmp/owned/1/stdout" };
    if (method === "capability.hosts.startOwned") return { pid: 42 };
    if (method === "capability.hosts.pollOwned") return { state: "exited", exitCode: 0 };
    if (method === "capability.hosts.readOwnedOutput") return {
      stdoutBase64: Buffer.from("remote complete\n").toString("base64"), stderrBase64: "" };
    if (method === "capability.hosts.transferOwned") return { transferred: false };
    throw Error(`unexpected ${method}`);
  } };
  const result = await handlers["executor.run"]({ task: { id: "t-fixture", rev: 2 }, attempt: 1,
    runDir: 1, remote: { timeoutMs: 5000, executor: "codex@box", model: null } },
  host as any, new AbortController().signal);
  expect(executorAttemptOutcome.safeParse(result).success).toBe(true);
  expect(result).toMatchObject({ report: "remote complete", attempt: { executor: "codex@box", exitCode: 0 } });
  expect(methods).toEqual(["capability.hosts.prepareOwned", "capability.hosts.claimOwned",
    "capability.hosts.startOwned", "capability.hosts.pollOwned", "capability.hosts.readOwnedOutput",
    "capability.hosts.transferOwned"]);
});

test("remote provider never retries an unreceipted START or claims on resume", async () => {
  const methods: string[] = [];
  const host = { call: async (method: string) => {
    methods.push(method);
    if (method === "capability.hosts.prepareOwned") return { worktree: "/home/x/worktree", branch: "pacer/t-fixture" };
    if (method === "capability.hosts.claimOwned") return { startedAt: 100, logFile: "/tmp/owned/1/stdout" };
    throw Error("lost START receipt");
  } };
  await expect(handlers["executor.run"]({ task: { id: "t-fixture", rev: 2 }, attempt: 1,
    runDir: 1, remote: { timeoutMs: 5000, executor: "codex@box", model: null } },
  host as any, new AbortController().signal)).rejects.toThrow("lost START receipt");
  expect(methods).toEqual(["capability.hosts.prepareOwned", "capability.hosts.claimOwned",
    "capability.hosts.startOwned"]);
  methods.length = 0;
  const recovered = { call: async (method: string) => {
    methods.push(method);
    if (method === "capability.hosts.pollOwned") return { state: "exited", exitCode: 0 };
    if (method === "capability.hosts.readOwnedOutput") return { stdoutBase64: "", stderrBase64: "" };
    if (method === "capability.hosts.transferOwned") return { transferred: false };
    throw Error(`unexpected ${method}`);
  } };
  await handlers["executor.run"]({ task: { id: "t-fixture", rev: 3 }, attempt: 1,
    runDir: 1, remote: { timeoutMs: 5000, executor: "codex@box", model: null,
      resume: { startedAt: 100, logFile: "/tmp/owned/1/stdout" } } },
  recovered as any, new AbortController().signal);
  expect(methods).toEqual(["capability.hosts.pollOwned", "capability.hosts.readOwnedOutput",
    "capability.hosts.transferOwned"]);
});

test("remote provider refuses an uncertain transfer without another START or direct SSH", async () => {
  const methods: string[] = [];
  const host = { call: async (method: string) => {
    methods.push(method);
    if (method === "capability.hosts.pollOwned") return { state: "exited", exitCode: 0 };
    if (method === "capability.hosts.readOwnedOutput") return { stdoutBase64: "", stderrBase64: "" };
    if (method === "capability.hosts.transferOwned") throw Error("transfer receipt lost");
    throw Error(`unexpected ${method}`);
  } };
  await expect(handlers["executor.run"]({ task: { id: "t-fixture", rev: 3 }, attempt: 1,
    runDir: 1, remote: { timeoutMs: 5000, executor: "codex@box", model: null,
      resume: { startedAt: 100, logFile: "/tmp/owned/1/stdout" } } },
  host as any, new AbortController().signal)).rejects.toThrow("transfer receipt lost");
  expect(methods).toEqual(["capability.hosts.pollOwned", "capability.hosts.readOwnedOutput",
    "capability.hosts.transferOwned"]);
});
