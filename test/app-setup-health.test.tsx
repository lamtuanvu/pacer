import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import {
  pendingSetupHealthReport,
  SetupHealthChip,
  SetupHealthStage,
} from "../app/src/screens/setup/SetupHealth";
import {
  setupHealthFailureReport,
} from "../app/src/screens/setup/SetupHealthGate";
import type { SetupHealthReport, SetupHealthRepair } from "../src/view-model/setup-health";

const okReport = (): SetupHealthReport => ({
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
});

test("Checking setup stage shows brand title, ordered steps, and polite live region", () => {
  const html = renderToString(<SetupHealthStage report={pendingSetupHealthReport("startup")} busy onContinue={() => {}} onOpenDiagnostics={() => {}} />);
  expect(html).toContain("Checking setup");
  expect(html).toContain("Making sure agents can work through pacer.");
  expect(html).toContain('aria-label="Setup checks"');
  expect(html).toContain("Service ready");
  expect(html).toContain("Detect agents");
  expect(html).toContain("Integrations &amp; hooks");
  expect(html).toContain("Usage &amp; eligibility");
  expect(html).toContain("Ready to take work");
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("pacer");
  expect(html).not.toContain("Continue");
});

test("after-update eyebrow and hard-fail CTAs", () => {
  const report: SetupHealthReport = {
    ...okReport(),
    trigger: "update",
    eyebrow: "After update · checking setup",
    outcome: "hard_fail",
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "service" ? { ...s, state: "failed", detail: "not running" } : s),
    repairs: [{ kind: "remedy", label: "Review and fix", check: "Install cursor", remedy: { kind: "review", label: "Review and fix", op: "agent.preview", params: { agent: "cursor" } } }],
  };
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} onRepair={() => {}} />,
  );
  expect(html).toContain("After update · checking setup");
  expect(html).toContain("Continue anyway");
  expect(html).toContain("Open Diagnostics");
  expect(html).toContain("Review and fix");
  expect(html).toContain('role="alert"');
});

test("Setup OK and attention chips", () => {
  expect(renderToString(<SetupHealthChip outcome="ok" attentionCount={0} />)).toContain("Setup OK · checked just now");
  const warn = renderToString(<SetupHealthChip outcome="warnings" attentionCount={2} />);
  expect(warn).toContain("2 fixes recommended");
  expect(warn).toContain("Open Diagnostics");
});

test("failure report shows error, Not checked steps, one Open Diagnostics, Run checks again and Restart service", () => {
  const report = setupHealthFailureReport("startup", new Error("boom"));
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} onRerun={() => {}} onRestartService={() => {}} onRepair={() => {}} />,
  );
  expect(html).toContain("boom");
  expect((html.match(/data-state="not_checked"/g) ?? []).length).toBe(4);
  expect((html.match(/Open Diagnostics/g) ?? []).length).toBe(1);
  expect(html).toContain("Run checks again");
  expect(html).toContain("Restart service");
  expect((html.match(/pc-btn--primary/g) ?? []).length).toBe(1);
});

test("pending report renders Waiting/Checking and never Not checked", () => {
  const html = renderToString(<SetupHealthStage report={pendingSetupHealthReport("startup")} busy onContinue={() => {}} onOpenDiagnostics={() => {}} />);
  expect(html).toContain("Waiting");
  expect(html).toContain("Checking");
  expect(html).not.toContain("Not checked");
});

test("two auto run repairs render Fix 2 issues automatically with one primary", () => {
  const repair = (label: string): SetupHealthRepair => ({
    kind: "remedy",
    label,
    check: label,
    remedy: { kind: "auto", label, op: "limits.refresh", params: { account: "codex" }, consent: true },
  });
  const report: SetupHealthReport = {
    trigger: "startup",
    title: "Checking setup",
    support: "Making sure agents can work through pacer.",
    steps: [
      { id: "service", title: "Service ready", state: "passed" },
      { id: "detect_agents", title: "Detect agents", state: "needs_attention" },
      { id: "integrations", title: "Integrations & hooks", state: "passed" },
      { id: "usage_eligibility", title: "Usage & eligibility", state: "passed" },
      { id: "ready", title: "Ready to take work", state: "needs_attention" },
    ],
    outcome: "warnings",
    attentionCount: 1,
    checkedAt: 100,
    repairs: [repair("Fix A"), repair("Fix B")],
  };
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} onFixAll={() => {}} onRepair={() => {}} />,
  );
  expect(html).toContain("Fix 2 issues automatically");
  expect((html.match(/pc-btn--primary/g) ?? []).length).toBe(1);
});

test("one auto run repair renders its own label and no issues automatically", () => {
  const report: SetupHealthReport = {
    trigger: "startup",
    title: "Checking setup",
    support: "Making sure agents can work through pacer.",
    steps: [
      { id: "service", title: "Service ready", state: "passed" },
      { id: "detect_agents", title: "Detect agents", state: "needs_attention" },
      { id: "integrations", title: "Integrations & hooks", state: "passed" },
      { id: "usage_eligibility", title: "Usage & eligibility", state: "passed" },
      { id: "ready", title: "Ready to take work", state: "needs_attention" },
    ],
    outcome: "warnings",
    attentionCount: 1,
    checkedAt: 100,
    repairs: [{ kind: "remedy", label: "Fix one thing", check: "Fix one thing", remedy: { kind: "auto", label: "Fix one thing", op: "limits.refresh", params: { account: "codex" }, consent: true } }],
  };
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} onRepair={() => {}} />,
  );
  expect(html).toContain("Fix one thing");
  expect(html).not.toContain("issues automatically");
});
