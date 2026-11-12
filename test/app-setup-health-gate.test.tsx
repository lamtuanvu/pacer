import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type { BrowserApi } from "../app/src/data/api";
import { SetupHealthStage } from "../app/src/screens/setup/SetupHealth";
import {
  applyRepair,
  commitSetupHealthLoad,
  gateRemedyHost,
  loadSetupHealthGate,
  setupHealthFailureReport,
} from "../app/src/screens/setup/SetupHealthGate";
import { remedies } from "../src/install/doctor-remedy";
import type { SetupHealthReport, SetupHealthRepair } from "../src/view-model/setup-health";

const okReport = (): SetupHealthReport & { skipFullWindow?: boolean } => ({
  trigger: "startup",
  title: "Checking setup",
  support: "Making sure agents can work through pacer.",
  steps: [
    { id: "service", title: "Service ready", state: "passed" },
    { id: "detect_agents", title: "Detect agents", state: "passed" },
    { id: "integrations", title: "Integrations & hooks", state: "passed" },
    { id: "usage_eligibility", title: "Usage & eligibility", state: "passed" },
    { id: "ready", title: "Ready to take work", state: "passed" },
  ],
  outcome: "ok",
  attentionCount: 0,
  checkedAt: 100,
  skipFullWindow: false,
});

test("setup.health rejection maps to a hard_fail gate that stays until Continue", () => {
  const report = setupHealthFailureReport("startup");
  expect(report.outcome).toBe("hard_fail");
  expect(report.steps.find(s => s.id === "service")?.state).toBe("failed");
  expect(report.steps.find(s => s.id === "service")?.detail).toContain("could not finish");
  expect(report.repairs?.[0]?.kind).toBe("open.diagnostics");
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} />,
  );
  expect(html).toContain("Continue anyway");
  expect(html).toContain("Open Diagnostics");
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("Continue to pacer");
});

test("loadSetupHealthGate never silently skips when setup.health rejects", async () => {
  const call = (async () => {
    throw new Error("unavailable");
  }) as BrowserApi["call"];
  const result = await loadSetupHealthGate(call);
  expect(result.kind).toBe("fail");
  if (result.kind !== "fail") return;
  expect(result.report.outcome).toBe("hard_fail");
  expect(result.report.steps.find(s => s.id === "service")?.detail).toContain("could not finish");
});

test("loadSetupHealthGate skips only when the op says skipFullWindow", async () => {
  const call = (async () => ({ ...okReport(), skipFullWindow: true })) as BrowserApi["call"];
  const result = await loadSetupHealthGate(call);
  expect(result.kind).toBe("skip");
  if (result.kind !== "skip") return;
  expect(result.summary.outcome).toBe("ok");
});

test("loadSetupHealthGate keeps hard_fail on stage without auto-enter", async () => {
  const call = (async () => ({
    ...okReport(),
    outcome: "hard_fail" as const,
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "service" ? { ...s, state: "failed" as const } : s),
  })) as BrowserApi["call"];
  const result = await loadSetupHealthGate(call);
  expect(result.kind).toBe("stage");
  if (result.kind !== "stage") return;
  expect(result.report.outcome).toBe("hard_fail");
  expect(result.autoEnterMs).toBeUndefined();
});

test("SetupHealthGate commit path: rejecting setup.health stays on stage (no silent ready)", async () => {
  const call = (async () => {
    throw new Error("unavailable");
  }) as BrowserApi["call"];
  const load = await loadSetupHealthGate(call);
  const commit = commitSetupHealthLoad(load);
  expect(commit.action).toBe("stage");
  if (commit.action !== "stage") return;
  expect(commit.report.outcome).toBe("hard_fail");
  expect(commit.autoEnterMs).toBeUndefined();
  expect(commit.report.steps.find(s => s.id === "service")?.detail).toContain("could not finish");
});

test("SetupHealthGate commit path: hard_fail report stays on stage without auto-enter", async () => {
  const call = (async () => ({
    ...okReport(),
    outcome: "hard_fail" as const,
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "service" ? { ...s, state: "failed" as const } : s),
  })) as BrowserApi["call"];
  const commit = commitSetupHealthLoad(await loadSetupHealthGate(call));
  expect(commit.action).toBe("stage");
  if (commit.action !== "stage") return;
  expect(commit.autoEnterMs).toBeUndefined();
});

test("SetupHealthGate commit path: warnings report stays on stage without auto-enter", async () => {
  const call = (async () => ({
    ...okReport(),
    outcome: "warnings" as const,
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "integrations" ? { ...s, state: "needs_attention" as const } : s),
  })) as BrowserApi["call"];
  const commit = commitSetupHealthLoad(await loadSetupHealthGate(call));
  expect(commit.action).toBe("stage");
  if (commit.action !== "stage") return;
  expect(commit.report.outcome).toBe("warnings");
  expect(commit.autoEnterMs).toBeUndefined();
});

test("SetupHealthGate commit path: skipFullWindow is the only silent ready entry", async () => {
  const skip = commitSetupHealthLoad(await loadSetupHealthGate(
    (async () => ({ ...okReport(), skipFullWindow: true })) as BrowserApi["call"],
  ));
  expect(skip.action).toBe("ready");
  const ok = commitSetupHealthLoad(await loadSetupHealthGate(
    (async () => okReport()) as BrowserApi["call"],
  ));
  expect(ok.action).toBe("stage");
  if (ok.action !== "stage") return;
  expect(ok.autoEnterMs).toBe(600);
});

function gateHarness(answer = true) {
  const calls: [string, unknown][] = [], asked: [string, string | undefined, string | undefined][] = [], opened: string[] = [];
  const api = { call: async (op: string, params: unknown) => {
    calls.push([op, params]);
    if (op === "agent.preview") return { revision: "rev-3", agent: (params as { agent: string }).agent, files: ["$HOME/.cursor/hooks.json"] };
    if (op === "doctor.fix.delegate") return { task: { task_id: "t 7" } };
    return {};
  } } as unknown as Pick<BrowserApi, "call">;
  const host = gateRemedyHost(api, async (message, title, label) => { asked.push([message, title, label]); return answer; }, url => opened.push(url));
  return { host, calls, asked, opened };
}
const repair = (check: string, remedy: SetupHealthRepair["remedy"]): SetupHealthRepair => ({ kind: "remedy", label: remedy!.label, check, remedy });

async function withLocation<T>(run: (location: { hash: string }) => Promise<T>): Promise<T> {
  const previous = (globalThis as { location?: unknown }).location;
  const location = { hash: "#/" };
  (globalThis as { location?: unknown }).location = location;
  try { return await run(location); } finally { (globalThis as { location?: unknown }).location = previous; }
}

test("gate repairs use the shared remedy dispatch: automatic remedies rerun, consent only after confirm", async () => {
  const plain = gateHarness();
  expect(await applyRepair(repair("Usage codex", remedies.refreshUsage("codex")), plain.host)).toBe("rerun");
  expect(plain.calls).toEqual([["limits.refresh", { account: "codex" }]]);
  expect(plain.asked).toEqual([]);
  const files = gateHarness();
  expect(await applyRepair(repair("Integration freshness cursor", remedies.updateFiles("cursor")), files.host)).toBe("rerun");
  expect(files.asked[0]![0]).toContain("$HOME/.cursor/hooks.json");
  expect(files.calls).toEqual([["agent.preview", { agent: "cursor" }], ["agent.connect", { agent: "cursor", preview_revision: "rev-3", consent: true }]]);
  const declined = gateHarness(false);
  expect(await applyRepair(repair("Service", remedies.service("Restart service")), declined.host)).toBe("done");
  expect(declined.asked[0]![0]).toContain("restarts its background service");
  expect(declined.calls).toEqual([]);
});

test("gate review repairs show the files and apply that preview's revision", async () => {
  const gate = gateHarness();
  expect(await applyRepair(repair("Install cursor", remedies.review("cursor")), gate.host)).toBe("rerun");
  expect(gate.asked[0]![0]).toContain("$HOME/.cursor/hooks.json");
  expect(gate.calls).toEqual([["agent.preview", { agent: "cursor" }], ["agent.connect", { agent: "cursor", consent: true, preview_revision: "rev-3" }]]);
});

test("gate user remedies sign in or open an allowed link and rerun when the person returns", async () => {
  const gate = gateHarness();
  expect(await applyRepair(repair("Usage codex", remedies.signIn("codex", "Codex")), gate.host)).toBe("rerun-on-return");
  expect(await applyRepair(repair("Removable volume access", remedies.privacySettings()), gate.host)).toBe("rerun-on-return");
  expect(gate.calls).toEqual([["account.signin", { name: "codex" }]]);
  expect(gate.opened).toHaveLength(1);
  expect(gate.opened[0]).toStartWith("x-apple.systempreferences:");
});

test("gate agent remedies start a fix task after confirm and open it; no remedy opens Diagnostics", async () => {
  await withLocation(async location => {
    const gate = gateHarness();
    expect(await applyRepair(repair("Binary cursor", remedies.agent("Binary cursor")), gate.host)).toBe("navigate");
    expect(gate.calls).toEqual([["doctor.fix.delegate", { check: "Binary cursor", scope: "fix" }]]);
    expect(location.hash).toBe("#/tasks/t%207");
    const declined = gateHarness(false);
    expect(await applyRepair(repair("Binary cursor", remedies.agent("Binary cursor")), declined.host)).toBe("done");
    expect(declined.calls).toEqual([]);
    expect(await applyRepair({ kind: "open.diagnostics", label: "Open Diagnostics" }, gateHarness().host)).toBe("navigate");
    expect(location.hash).toBe("#/settings/diagnostics");
  });
});

test("the gate's repair host waits for the restarted service before its rerun", async () => {
  const { gateRemedyHost } = await import("../app/src/screens/setup/SetupHealthGate");
  const pids = [10, 11];
  const api = { call: async <T,>(op: string) => { expect(op).toBe("snapshot.get"); return { snapshot: { service: { pid: pids.shift() ?? 11 } } } as T; } };
  const host = gateRemedyHost(api as never, async () => true, () => {});
  await host.awaitRestart!(10);
  expect(pids).toEqual([]);
});

test("the gate's restart wait keeps one snapshot.get in flight: its call is one stable function per host", async () => {
  let calls = 0, releaseRead!: (value: unknown) => void;
  const api = {
    call: async <T,>(op: string) => {
      if (op !== "snapshot.get") return {} as T;
      if (++calls === 1) return new Promise<T>(resolve => { releaseRead = value => resolve(value as T); });
      return { snapshot: { service: { pid: 11 } } } as T;
    },
  } as unknown as Pick<BrowserApi, "call">;
  const host = gateRemedyHost(api, async () => true);
  const wait = host.awaitRestart!(10);
  // The first poll's read holds past servicePid's own timeout; the next poll must reuse that
  // pending read (same call identity) instead of starting a second request.
  await new Promise<void>(resolve => setTimeout(resolve, 4500));
  expect(calls).toBe(1);
  releaseRead({ snapshot: { service: { pid: 11 } } });
  await wait;
  expect(calls).toBe(1);
}, 20000);
