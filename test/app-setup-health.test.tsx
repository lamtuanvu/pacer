import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import {
  pendingSetupHealthReport,
  SetupHealthChip,
  SetupHealthStage,
} from "../app/src/screens/setup/SetupHealth";
import type { SetupHealthReport } from "../src/view-model/setup-health";

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
