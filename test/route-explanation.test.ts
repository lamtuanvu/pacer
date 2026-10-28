import { expect, test } from "bun:test";
import { routeReasonCopy } from "../src/view-model/route-explanation";
import { clock } from "../src/view-model/time";

const now = 1_800_000_000;
const codes = ["executor_busy", "machine_busy", "quota_exhausted", "runner_disabled", "blocked_by_user", "signed_out", "not_installed", "not_configured", "unavailable", "ineligible", "runner_unhealthy", "requirements_not_met", "host_unreachable", "host_reachability_unknown", "host_paused", "repo_not_on_host", "enforcement_uncertified"];
for (const code of codes) test(`${code} names the executor and ignores service prose`, () => {
  const reason = { code, subject: "codex#team", facts: {}, text: "CLI prose never shown" };
  const copy = routeReasonCopy(reason, now, "cursor");
  expect(copy).toStartWith("Codex · team ");
  expect(copy).not.toContain(reason.text);
  if (code !== "unavailable") expect(copy).not.toBe("Codex · team is not available right now.");
});
// unavailable intentionally uses the generic words.
test("unavailable states the executor is unavailable", () => {
  expect(routeReasonCopy({ code: "unavailable", subject: "codex", facts: {} }, now)).toBe("Codex is not available right now.");
});
for (const [code, key] of [["quota_exhausted", "resetsAt"], ["paused", "until"]]) test(`${code} formats Unix time using the shared clock`, () => {
  const at = now + 3600;
  const copy = routeReasonCopy({ code: code!, subject: "codex", facts: { [key!]: at } }, now);
  expect(copy).toContain(clock(at, now));
  expect(copy).not.toMatch(/\d{10}/);
  expect(routeReasonCopy({ code: code!, facts: {} }, now)).not.toContain("until");
});
for (const code of ["other_exclusion", "unknown_future_code", "toString", "__proto__"]) test(`${code} never echoes opaque text or subject`, () => {
  const reason = { code, subject: "private free text", facts: {}, text: "CLI private prose" };
  expect(routeReasonCopy(reason, now, "codex")).toBe("Codex is not available right now.");
  expect(routeReasonCopy(reason, now)).toBe("Executor is not available right now.");
});
test("a known exclusion without a subject names its fallback runner", () => {
  expect(routeReasonCopy({ code: "machine_busy", facts: {} }, now, "cursor")).toBe("Cursor is waiting for space on this machine.");
});

test("dispatcher-wide reasons name no executor", () => {
  expect(routeReasonCopy({ code: "no_step_matched", subject: "codex", facts: {} }, now)).toBe("No agent qualifies for any step of the strategy.");
  expect(routeReasonCopy({ code: "step_no_candidates", facts: {} }, now, "codex")).toBe("No agent qualifies for this step of the strategy.");
  expect(routeReasonCopy({ code: "engine_failed", facts: {} }, now)).toBe("Pacer could not decide where new work goes, so nothing was chosen.");
  expect(routeReasonCopy({ code: "paused", facts: { until: now + 3600 } }, now)).toBe(`Dispatch is paused until ${clock(now + 3600, now)}.`);
});
test("a busy executor states its running count when the service gives one", () => {
  expect(routeReasonCopy({ code: "executor_busy", subject: "codex", facts: { used: 2, limit: 2 } }, now)).toBe("Codex is busy (2 of 2 running).");
  expect(routeReasonCopy({ code: "executor_busy", subject: "codex", facts: {} }, now)).toBe("Codex is busy with other work.");
});
