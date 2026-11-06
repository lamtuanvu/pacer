import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type { BrowserApi } from "../app/src/data/api";
import { SetupHealthStage } from "../app/src/screens/setup/SetupHealth";
import {
  commitSetupHealthLoad,
  loadSetupHealthGate,
  setupHealthFailureReport,
} from "../app/src/screens/setup/SetupHealthGate";
import type { SetupHealthReport } from "../src/view-model/setup-health";

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
