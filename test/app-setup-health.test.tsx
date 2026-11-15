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
import { clickText, domText, installDom, mount, tick, unmount } from "./app-setup-health-dom";

const okReport = (): SetupHealthReport => ({
  trigger: "startup",
  title: "Checking setup",
  support: "Making sure agents can work through pacer.",
  steps: [
    { id: "service", title: "Service ready", state: "passed" },
    { id: "detect_agents", title: "Detect agents", state: "passed" },
    { id: "integrations", title: "Integrations & hooks", state: "passed" },
    { id: "usage_eligibility", title: "Usage & eligibility", state: "passed" },
    { id: "notifications", title: "Turn on notifications", state: "passed" },
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
  expect((html.match(/data-state="not_checked"/g) ?? []).length).toBe(5);
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

test("SetupHealthStage clicks run rerun and restart props (DOM)", async () => {
  const dom = installDom();
  try {
    const report = setupHealthFailureReport("startup", new Error("boom"));
    const reruns: number[] = [];
    const restarts: number[] = [];
    await mount(dom, (
      <SetupHealthStage
        report={report}
        onContinue={() => {}}
        onOpenDiagnostics={() => {}}
        onRerun={() => reruns.push(1)}
        onRestartService={() => restarts.push(1)}
      />
    ));
    await tick();
    expect(domText(dom.container)).toContain("Run checks again");
    expect(domText(dom.container)).toContain("Restart service");
    clickText(dom.container, "Run checks again");
    clickText(dom.container, "Restart service");
    expect(reruns).toHaveLength(1);
    expect(restarts).toHaveLength(1);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("the notifications step renders and its skippable repair offers Skip", () => {
  const warn: SetupHealthReport = {
    ...okReport(),
    outcome: "warnings",
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "notifications" ? { ...s, state: "needs_attention", detail: "Notification permission not asked yet" } : s),
    repairs: [{ kind: "remedy", label: "Allow notifications", check: "Notifications", skip: true, remedy: { kind: "auto", label: "Allow notifications", op: "notifications.request" } }],
  };
  const html = renderToString(
    <SetupHealthStage report={warn} onContinue={() => {}} onOpenDiagnostics={() => {}} onRepair={() => {}} onSkip={() => {}} />,
  );
  expect(html).toContain("Turn on notifications");
  expect(html).toContain("Notification permission not asked yet");
  expect(html).toContain("Allow notifications");
  expect(html).toContain("Skip notifications");
  // No skip affordance when no optional step needs attention.
  const plain = renderToString(<SetupHealthStage report={okReport()} onContinue={() => {}} onOpenDiagnostics={() => {}} />);
  expect(plain).not.toContain("Skip notifications");
});

test("a skipped notifications step reads 'Skipped', adds no repair, and shows Run checks again", () => {
  const skipped: SetupHealthReport = {
    ...okReport(),
    outcome: "ok",
    attentionCount: 0,
    steps: okReport().steps.map(s => s.id === "notifications" ? { ...s, state: "skipped", detail: "Skipped" } : s),
    // Skipping contributes no repair: no "Allow notifications" primary, and Run checks
    // again / Restart stay available.
    repairs: undefined,
  };
  const html = renderToString(
    <SetupHealthStage report={skipped} onContinue={() => {}} onOpenDiagnostics={() => {}} onRerun={() => {}} onRestartService={() => {}} onRepair={() => {}} onSkip={() => {}} />,
  );
  expect(html).toContain("Skipped");
  expect(html).not.toContain("Skip notifications");
  expect(html).not.toContain("Allow notifications");
  expect(html).toContain("Run checks again");
  expect(html).toContain("Restart service");
});

test("skipping notifications excludes it from fix-all but keeps it as an individual action", () => {
  const report: SetupHealthReport = {
    ...okReport(),
    outcome: "warnings",
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "notifications" ? { ...s, state: "skipped", detail: "Skipped" } : s),
    repairs: [
      { kind: "remedy", label: "Refresh usage", check: "Usage codex", remedy: { kind: "auto", label: "Refresh usage", op: "limits.refresh", params: { account: "codex" }, consent: true } },
      { kind: "remedy", label: "Install service", check: "Service", remedy: { kind: "auto", label: "Install service", op: "service.install" } },
    ],
  };
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} onFixAll={() => {}} onRepair={() => {}} onSkip={() => {}} />,
  );
  // Fix-all counts only the two automatic repairs, never notifications.request.
  expect(html).toContain("Fix 2 issues automatically");
  expect(html).not.toContain("Allow notifications");
});

test("with one other automatic repair (no fix-all) Allow notifications still has its own action", () => {
  const report: SetupHealthReport = {
    ...okReport(),
    outcome: "warnings",
    attentionCount: 2,
    steps: okReport().steps.map(s => s.id === "notifications" ? { ...s, state: "needs_attention", detail: "Notification permission not asked yet" }
      : s.id === "usage_eligibility" ? { ...s, state: "needs_attention" } : s),
    repairs: [
      { kind: "remedy", label: "Refresh usage", check: "Usage codex", remedy: { kind: "auto", label: "Refresh usage", op: "limits.refresh", params: { account: "codex" } } },
      { kind: "remedy", label: "Allow notifications", check: "Notifications", skip: true, remedy: { kind: "auto", label: "Allow notifications", op: "notifications.request" } },
    ],
  };
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} onFixAll={() => {}} onRepair={() => {}} onSkip={() => {}} />,
  );
  expect(html).not.toContain("issues automatically");
  expect(html).toContain("Refresh usage");
  expect((html.match(/Allow notifications/g) ?? []).length).toBe(1);
  expect((html.match(/pc-btn--primary/g) ?? []).length).toBe(1);
});
