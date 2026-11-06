import { describe, expect, test } from "bun:test";
import type { Check } from "../src/install/doctor";
import type { SetupChecklist } from "../src/setup/checklist";
import {
  aggregateSetupHealth,
  shouldSkipFullWindow,
  type SetupHealthFingerprint,
} from "../src/view-model/setup-health";

const checklist = (over: Partial<SetupChecklist> = {}): SetupChecklist => ({
  checkedAt: 1,
  complete: true,
  ready: true,
  items: [
    { id: "service", title: "Background service", status: "done", required: true },
    { id: "executor", title: "Executor", status: "done", required: false },
  ],
  ...over,
});

describe("aggregateSetupHealth", () => {
  test("maps a clean doctor report into five passed steps", () => {
    const checks: Check[] = [
      { name: "Service", level: "ok", detail: "installed: true; running: true; healthy: true" },
      { name: "Binary codex", level: "ok", detail: "codex installed" },
      { name: "Binary cursor", level: "ok", detail: "cursor-agent installed" },
      { name: "Install claude-code", level: "ok", detail: "installed files intact", evidence: "configured" },
      { name: "Usage codex", level: "ok", detail: "OK" },
    ];
    const report = aggregateSetupHealth({ checks, checklist: checklist(), trigger: "startup", checkedAt: 100 });
    expect(report.title).toBe("Checking setup");
    expect(report.support).toContain("agents can work through pacer");
    expect(report.eyebrow).toBeUndefined();
    expect(report.steps.map(s => s.id)).toEqual([
      "service",
      "detect_agents",
      "integrations",
      "usage_eligibility",
      "ready",
    ]);
    expect(report.steps.every(s => s.state === "passed")).toBe(true);
    expect(report.outcome).toBe("ok");
    expect(report.attentionCount).toBe(0);
  });

  test("after-update trigger sets the eyebrow", () => {
    const report = aggregateSetupHealth({
      checks: [{ name: "Service", level: "ok", detail: "ok" }],
      checklist: checklist(),
      trigger: "update",
      checkedAt: 1,
    });
    expect(report.eyebrow).toBe("After update · checking setup");
  });

  test("integration drift becomes needs_attention and warning outcome", () => {
    const checks: Check[] = [
      { name: "Service", level: "ok", detail: "ok" },
      { name: "Binary cursor", level: "ok", detail: "ok" },
      {
        name: "Install cursor",
        level: "warn",
        detail: "managed integration content changed: hooks.json",
        fix: "pacer install cursor",
        evidence: "configured",
      },
      { name: "Usage cursor", level: "ok", detail: "OK" },
    ];
    const report = aggregateSetupHealth({ checks, checklist: checklist(), trigger: "startup", checkedAt: 1 });
    expect(report.steps.find(s => s.id === "integrations")?.state).toBe("needs_attention");
    expect(report.outcome).toBe("warnings");
    expect(report.attentionCount).toBeGreaterThan(0);
  });

  test("service fail is hard_fail", () => {
    const checks: Check[] = [
      { name: "Service", level: "fail", detail: "not running", fix: "pacer service install" },
    ];
    const report = aggregateSetupHealth({
      checks,
      checklist: checklist({
        complete: false,
        ready: false,
        items: [{ id: "service", title: "Background service", status: "failed", required: true, detail: "not running" }],
      }),
      trigger: "startup",
      checkedAt: 1,
    });
    expect(report.steps.find(s => s.id === "service")?.state).toBe("failed");
    expect(report.outcome).toBe("hard_fail");
  });

  test("timed-out steps become needs_attention", () => {
    const report = aggregateSetupHealth({
      checks: [{ name: "Service", level: "ok", detail: "ok" }],
      checklist: checklist(),
      trigger: "startup",
      checkedAt: 1,
      timedOutSteps: ["usage_eligibility"],
    });
    const usage = report.steps.find(s => s.id === "usage_eligibility");
    expect(usage?.state).toBe("needs_attention");
    expect(usage?.detail?.toLowerCase()).toContain("timed");
    expect(report.outcome).toBe("warnings");
  });
});

describe("shouldSkipFullWindow", () => {
  const base: SetupHealthFingerprint = {
    schema: 1,
    appVersion: "0.14.0",
    serviceVersion: "0.14.0",
    integrationHashes: { "claude-code": "aaa", cursor: "bbb" },
    attentionCount: 0,
    checkedAt: 50,
    stepVerdicts: {
      service: "passed",
      detect_agents: "passed",
      integrations: "passed",
      usage_eligibility: "passed",
      ready: "passed",
    },
  };

  test("skips when versions and hashes match and attention is zero", () => {
    expect(shouldSkipFullWindow(base, {
      appVersion: "0.14.0",
      serviceVersion: "0.14.0",
      integrationHashes: { "claude-code": "aaa", cursor: "bbb" },
    })).toBe(true);
  });

  test("forces the stage after a version bump", () => {
    expect(shouldSkipFullWindow(base, {
      appVersion: "0.14.1",
      serviceVersion: "0.14.0",
      integrationHashes: { "claude-code": "aaa", cursor: "bbb" },
    })).toBe(false);
  });

  test("forces when attention remained or hashes drifted", () => {
    expect(shouldSkipFullWindow({ ...base, attentionCount: 2 }, {
      appVersion: "0.14.0",
      serviceVersion: "0.14.0",
      integrationHashes: { "claude-code": "aaa", cursor: "bbb" },
    })).toBe(false);
    expect(shouldSkipFullWindow(base, {
      appVersion: "0.14.0",
      serviceVersion: "0.14.0",
      integrationHashes: { "claude-code": "aaa", cursor: "CHANGED" },
    })).toBe(false);
  });

  test("forces when no last pass exists", () => {
    expect(shouldSkipFullWindow(null, {
      appVersion: "0.14.0",
      serviceVersion: "0.14.0",
      integrationHashes: {},
    })).toBe(false);
  });
});
