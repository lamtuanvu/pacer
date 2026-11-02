import { describe, expect, test } from "bun:test";
import { benchmarkLimitations, benchmarkMarkdown, benchmarkReport, requiredJobs, variants } from "../scripts/release/experiment-benchmark";

const identity = { repository: "owner/repo", run: "123", attempt: "2", commit: "a".repeat(40), version: "1.2.3" };
const t0 = "2026-11-02T00:00:00Z";
function jobs() {
  const time = (seconds: number) => new Date(Date.parse(t0) + seconds * 1000).toISOString();
  return requiredJobs.map((name, i) => {
    const [created, start, end] = name === "candidate" ? [0, 10, 20] : name === "focused" ? [20, 30, 50] :
      name === "promotion" ? [100, 110, 120] : name.startsWith("cli-") ? [20, 60, 70] : [70, 80, 100];
    return { name, run_id: 123, head_sha: identity.commit,
    status: "completed", conclusion: "success", created_at: t0,
    started_at: time(start), completed_at: time(end),
    steps: [{ name: "Set up job", status: "completed", conclusion: "success",
      started_at: time(start), completed_at: time(start + 2) },
    { name: "Build", status: "completed", conclusion: "success",
      started_at: time(start + 2), completed_at: time(end) }], id: i + 1 };
  });
}

describe("release experiment benchmark", () => {
  test("reports dispatch elapsed, queues and stages without summing parallel jobs", () => {
    const report = benchmarkReport(identity, t0, jobs(), "2026-11-02T00:03:00Z");
    expect(report.verdict).toBe("PASS");
    expect(report.elapsedSeconds).toBe(120);
    expect(report.observedSeconds).toBe(180);
    expect(report.jobs[0].queueSeconds).toBe(10);
    expect(report.jobs[0].steps[1].seconds).toBe(8);
    expect(report.lowerBound).toBe("WITHIN_DEADLINE");
    expect(report.fullReleaseDeadline).toBe("UNVERIFIED");
    expect(variants).toHaveLength(8);
  });
  test("reports push receipt, queue plus setup and setup timestamps", () => {
    const report = benchmarkReport(identity, t0, jobs(), "2026-11-02T00:03:00Z", "2026-11-01T23:59:55Z");
    expect(report.pushedAt).toBe("2026-11-01T23:59:55Z");
    expect(report.pushToRunCreatedSeconds).toBe(5);
    const candidate = report.jobs.find(j => j.name === "candidate")!, desktop = report.jobs.find(j => j.name === "desktop-linux-x64")!;
    // Roots count from t0; dependents count from their last dependency's completion.
    expect([candidate.setupSeconds, candidate.queuePlusSetupSeconds]).toEqual([2, 12]);
    expect(desktop.dependenciesReadyAt).toBe("2026-11-02T00:01:10.000Z");
    expect([desktop.setupSeconds, desktop.queuePlusSetupSeconds]).toEqual([2, 12]);
    expect(desktop.setupCompletedAt).toBe("2026-11-02T00:01:22.000Z");
    const missing = benchmarkReport(identity, t0, jobs().map(j => ({ ...j, steps: j.steps.slice(1) })), "2026-11-02T00:03:00Z");
    expect(missing.jobs[0].queuePlusSetupSeconds).toBeNull();
    expect(benchmarkReport(identity, t0, jobs(), "2026-11-02T00:03:00Z").pushToRunCreatedSeconds).toBeNull();
  });
  test("never presents the lower bound as a 30-minute release result", () => {
    for (const report of [benchmarkReport(identity, t0, jobs(), "2026-11-02T00:03:00Z"), benchmarkReport(identity, t0, [], "2026-11-02T00:03:00Z")]) {
      expect(report.kind).toBe("hosted-lower-bound-build-benchmark");
      expect(report.fullReleaseDeadline).toBe("UNVERIFIED");
      expect(report.limitations).toEqual(benchmarkLimitations);
      const markdown = benchmarkMarkdown(report);
      expect(markdown).toContain("This is not a 30-minute release result.");
      for (const limitation of benchmarkLimitations) expect(markdown).toContain(limitation);
      expect(markdown).not.toMatch(/\bMET\b|release (succeeded|passed)/i);
    }
    for (const excluded of ["Prepare PR", "merge", "tag", "signing", "notarization", "publication"]) {
      expect(benchmarkLimitations[0]).toContain(excluded);
    }
  });
  test("explicitly fails a deadline miss even when every job succeeded", () => {
    const late = jobs().map(job => job.name === "promotion" ? { ...job, completed_at: "2026-11-02T00:31:00Z" } : job);
    const report = benchmarkReport(identity, t0, late, "2026-11-02T00:32:00Z");
    expect(report.lowerBound).toBe("EXCEEDS_DEADLINE");
    expect(report.fullReleaseDeadline).toBe("UNVERIFIED");
    expect(report.verdict).toBe("FAIL");
  });
  test("reports queue estimates with an explicit unavailable raw job-creation timestamp", () => {
    const report = benchmarkReport(identity, t0, jobs().map(j => ({ ...j, created_at: undefined })), "2026-11-02T00:03:00Z");
    expect(report.verdict).toBe("PASS");
    expect(report.jobs[0].queueSeconds).toBeNull();
    expect(report.jobs[0].dependencyReadyToStartSeconds).toBe(10);
  });
  test("fails closed for missing, duplicate, failed, cancelled, skipped and foreign jobs", () => {
    const valid = jobs();
    for (const bad of [valid.slice(1), [...valid, valid[0]],
      ...["failure", "cancelled", "skipped", null].map(conclusion => valid.map((j, i) => i ? j : { ...j, conclusion })),
      valid.map((j, i) => i ? j : { ...j, run_id: 124 }),
      valid.map((j, i) => i ? j : { ...j, head_sha: "b".repeat(40) }),
      valid.map((j, i) => i ? j : { ...j, started_at: "invalid" }),
      valid.map((j, i) => i ? j : { ...j, steps: [] }),
    ]) expect(benchmarkReport(identity, t0, bad, "2026-11-02T00:03:00Z").verdict).toBe("FAIL");
  });
  test("does not label an incomplete fast run a deadline success", () => {
    const report = benchmarkReport(identity, t0, [], "2026-11-02T00:03:00Z");
    expect(report.lowerBound).toBe("UNVERIFIED");
    expect(report.verdict).toBe("FAIL");
  });
});
