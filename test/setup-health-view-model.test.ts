import { describe, expect, test } from "bun:test";
import type { Check } from "../src/install/doctor";
import { remedies } from "../src/install/doctor-remedy";
import type { SetupChecklist } from "../src/setup/checklist";
import {
  aggregateSetupHealth,
  setupHealthRepairs,
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

  test("service detail uses diagnosticSummary instead of raw status tuples", () => {
    const report = aggregateSetupHealth({
      checks: [{
        name: "Service",
        level: "warn",
        detail: "installed: true; running: true; healthy: false; binary matches current: false",
      }],
      checklist: checklist(),
      trigger: "startup",
      checkedAt: 1,
    });
    const detail = report.steps.find(s => s.id === "service")?.detail ?? "";
    expect(detail).not.toContain("installed: true");
    expect(detail.length).toBeGreaterThan(0);
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

describe("setupHealthRepairs", () => {
  const honesty = "Wiring OK · live enforcement unverified";

  test("one remedy per agent reconnect, with honesty for file repairs", () => {
    const checks: Check[] = [
      { name: "Claude hook configuration", level: "warn", detail: "SessionStart missing", remedy: remedies.review("claude-code") },
      { name: "Legacy guard", level: "warn", detail: "legacy subagent_guard.py present", remedy: remedies.review("claude-code") },
      { name: "Integration freshness cursor", level: "warn", detail: "managed files changed", remedy: remedies.updateFiles("cursor") },
      { name: "Install cursor", level: "warn", detail: "changed", remedy: remedies.review("cursor") },
      { name: "Install codex#work", level: "warn", detail: "changed", remedy: remedies.review("codex") },
    ];
    expect(setupHealthRepairs(checks)).toEqual([
      { kind: "remedy", label: "Review and fix", check: "Claude hook configuration", honesty, remedy: remedies.review("claude-code") },
      { kind: "remedy", label: "Update files", check: "Integration freshness cursor", honesty, remedy: remedies.updateFiles("cursor") },
      { kind: "remedy", label: "Review and fix", check: "Install codex#work", honesty, remedy: remedies.review("codex") },
    ]);
  });

  test("check names never pick a repair: problems without a remedy only open Diagnostics", () => {
    expect(setupHealthRepairs([
      { name: "Usage codex", level: "warn", detail: "stale usage" },
      { name: "Install cursor", level: "warn", detail: "changed" },
      { name: "Binary cursor", level: "fail", detail: "not found" },
    ])).toEqual([{ kind: "open.diagnostics", label: "Open Diagnostics" }]);
    expect(setupHealthRepairs([{ name: "Usage codex", level: "ok", detail: "OK" }])).toEqual([]);
  });

  test("every remedy kind becomes a remedy repair; internal problems share one restart", () => {
    const signIn = remedies.signIn("codex", "Codex");
    const refresh = remedies.refreshUsage("codex");
    const service = remedies.service("Restart service");
    const internal = remedies.internal();
    const agent = remedies.agent("Binary cursor");
    const privacy = remedies.privacySettings();
    const checks: Check[] = [
      { name: "Usage codex", level: "warn", detail: "stale usage", remedy: signIn },
      { name: "Usage codex#tse", level: "warn", detail: "unknown", remedy: refresh },
      { name: "Service", level: "fail", detail: "down", remedy: service },
      { name: "Binary cursor", level: "fail", detail: "not found", remedy: agent },
      { name: "Install codex", level: "warn", evidence: "unverified", detail: "plugin unavailable", remedy: internal },
      { name: "Skill codex", level: "warn", evidence: "unverified", detail: "plugin unavailable", remedy: internal },
      { name: "Removable volume access", level: "warn", detail: "denied", remedy: privacy },
      { name: "Binary codex", level: "ok", detail: "found", remedy: agent },
    ];
    expect(setupHealthRepairs(checks)).toEqual([
      { kind: "remedy", label: "Sign in to Codex", check: "Usage codex", remedy: signIn },
      { kind: "remedy", label: "Refresh usage", check: "Usage codex#tse", remedy: refresh },
      { kind: "remedy", label: "Restart service", check: "Service", remedy: service },
      { kind: "remedy", label: "Fix with agent", check: "Binary cursor", remedy: agent },
      { kind: "remedy", label: "Restart pacer service", check: "Install codex", remedy: internal },
      { kind: "remedy", label: "Open Privacy settings", check: "Removable volume access", remedy: privacy },
    ]);
  });

  test("aggregateSetupHealth includes the repairs its remedies name", () => {
    const report = aggregateSetupHealth({
      checks: [{ name: "Install opencode", level: "warn", detail: "changed", remedy: remedies.review("opencode") }],
      checklist: checklist(),
      trigger: "startup",
      checkedAt: 1,
    });
    expect(report.repairs).toEqual([{ kind: "remedy", label: "Review and fix", check: "Install opencode", honesty, remedy: remedies.review("opencode") }]);
  });
});
