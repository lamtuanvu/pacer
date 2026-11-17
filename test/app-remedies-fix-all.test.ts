import { expect, test } from "bun:test";
import { runFixAll } from "../app/src/data/remedies";
import type { RemedyPlan } from "../src/view-model/diagnostics";

test("runFixAll: two consented runs call confirmAll once with 2 requests", async () => {
  const calls: string[] = [];
  let confirmCalls = 0;
  let confirmArgLen = 0;
  const host = {
    call: async (op: string) => { calls.push(op); if (op === "snapshot.get") return { snapshot: { service: { pid: 1 } } }; return {}; },
    awaitRestart: async () => {},
  };
  const items = [
    { id: "a", plan: { kind: "run", op: "limits.refresh", params: { account: "codex" }, consent: { title: "Refresh", message: "m1", confirmLabel: "Refresh" } } as RemedyPlan, title: "Refresh A" },
    { id: "b", plan: { kind: "run", op: "limits.refresh", params: { account: "claude-code" }, consent: { title: "Refresh", message: "m2", confirmLabel: "Refresh" } } as RemedyPlan, title: "Refresh B" },
  ];
  const result = await runFixAll(items, host as any, {
    confirmAll: async (requests) => { confirmCalls++; confirmArgLen = requests.length; return true; },
  });
  expect(confirmCalls).toBe(1);
  expect(confirmArgLen).toBe(2);
  expect(result.cancelled).toBe(false);
  expect(result.failures).toHaveLength(0);
  expect(calls.filter(c => c === "limits.refresh")).toHaveLength(2);
});

test("runFixAll: service.install item is committed last even when given first", async () => {
  const calls: string[] = [];
  const host = {
    call: async (op: string) => { calls.push(op); if (op === "snapshot.get") return { snapshot: { service: { pid: 1 } } }; return {}; },
    awaitRestart: async () => {},
  };
  const items = [
    { id: "svc", plan: { kind: "run", op: "service.install", params: {}, consent: { title: "Install", message: "m", confirmLabel: "Install" } } as RemedyPlan, title: "Install service" },
    { id: "lim", plan: { kind: "run", op: "limits.refresh", params: { account: "codex" }, consent: { title: "Refresh", message: "m", confirmLabel: "Refresh" } } as RemedyPlan, title: "Refresh" },
  ];
  const result = await runFixAll(items, host as any, { confirmAll: async () => true });
  expect(result.cancelled).toBe(false);
  const commitOps = calls.filter(c => c !== "snapshot.get");
  expect(commitOps).toEqual(["limits.refresh", "service.install"]);
});

test("runFixAll: a failing commit does not stop the next commit", async () => {
  let n = 0;
  const host = {
    call: async (op: string) => {
      if (op === "limits.refresh") {
        n++;
        if (n === 1) throw new Error("boom");
        return {};
      }
      return {};
    },
    awaitRestart: async () => {},
  };
  const items = [
    { id: "a", plan: { kind: "run", op: "limits.refresh", params: { account: "codex" } } as RemedyPlan, title: "A" },
    { id: "b", plan: { kind: "run", op: "limits.refresh", params: { account: "claude-code" } } as RemedyPlan, title: "B" },
  ];
  const result = await runFixAll(items, host as any);
  expect(result.failures).toHaveLength(1);
  expect(n).toBe(2);
});

test("runFixAll: cancelled confirmation commits nothing", async () => {
  const calls: string[] = [];
  const host = {
    call: async (op: string) => { calls.push(op); return {}; },
    awaitRestart: async () => {},
  };
  const items = [
    { id: "a", plan: { kind: "run", op: "limits.refresh", params: { account: "codex" }, consent: { title: "R", message: "m", confirmLabel: "R" } } as RemedyPlan, title: "A" },
  ];
  const result = await runFixAll(items, host as any, { confirmAll: async () => false });
  expect(result.cancelled).toBe(true);
  expect(calls).not.toContain("limits.refresh");
});

test("runFixAll: awaitRestart called once when a run restarts the service", async () => {
  let awaitCalls = 0;
  const host = {
    call: async (op: string) => {
      if (op === "snapshot.get") return { snapshot: { service: { pid: 1 } } };
      if (op === "service.install") return { restarting: true };
      return {};
    },
    awaitRestart: async () => { awaitCalls++; },
  };
  const items = [
    { id: "svc", plan: { kind: "run", op: "service.install", params: {}, consent: { title: "I", message: "m", confirmLabel: "I" } } as RemedyPlan, title: "Install" },
  ];
  const result = await runFixAll(items, host as any, { confirmAll: async () => true });
  expect(result.restarting).toBe(true);
  expect(awaitCalls).toBe(1);
});

test("runFixAll: awaitRestart never called when no run restarts the service", async () => {
  let awaitCalls = 0;
  const host = {
    call: async (op: string) => {
      if (op === "snapshot.get") return { snapshot: { service: { pid: 1 } } };
      return {};
    },
    awaitRestart: async () => { awaitCalls++; },
  };
  const items = [
    { id: "a", plan: { kind: "run", op: "limits.refresh", params: { account: "codex" }, consent: { title: "R", message: "m", confirmLabel: "R" } } as RemedyPlan, title: "A" },
  ];
  await runFixAll(items, host as any, { confirmAll: async () => true });
  expect(awaitCalls).toBe(0);
});