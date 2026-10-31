import { expect, test } from "bun:test";
import { draftStorage } from "../app/src/model/draft";
import { ApiError } from "../app/src/data/api";
import { EXPLAIN_OP, explainParams, explainRoute, type RouteExplanation } from "../app/src/data/explain-route";
import { createKeyRegistry, modShortcut, newTaskShortcut, shortcutLabel } from "../app/src/keys/registry";
import {
  agentOptions, blankNewTask, effectiveKind, kindChips, newTaskPayload, readChecks, readMentions, reasonText, routeCard, savedNote, submitState,
  validIssueUrl, retainedIssueSource, writeChecks, writeMentions, type NewTaskDraft,
} from "../app/src/model/new-task";
import { hrefFor, parentFor, primaryFor, resolveRoute, routes, titleFor, type Route } from "../app/src/router";
import { newTaskHref, openNewTask } from "../app/src/screens/new-task/entry";

const draft = (change: Partial<NewTaskDraft> = {}): NewTaskDraft => ({ ...blankNewTask, request: "Make remote-support access opt-out.", repo: "econ-v1/node", ...change });
const ctx = { requestId: "req-1", knownRepos: ["econ-v1/node"] };
function explanation(change: Partial<RouteExplanation> = {}): RouteExplanation {
  return {
    schemaVersion: 1, revision: "r1", at: 1, observedAt: 1, outcome: "select",
    kind: { value: "feature", source: "detected" },
    strategy: { name: "no-agy", draft: false, source: "project" },
    engine: { id: "builtin", version: "1" },
    chosen: { executor: "codex#work", account: "work", runner: "codex", model: { kind: "executor-default" }, host: null },
    step: { id: "s1", index: 0, skipped: [] },
    reasons: [{ code: "step_match", outcome: "pass", facts: { kind: "feature", stepId: "1" }, text: "ignored" }],
    fallbacks: [{ executor: "antigravity", runner: "antigravity", account: "a", state: "eligible" }],
    planner: { state: "estimate", tokens: { median: 60_000, p80: 90_000 }, samples: 12, basis: "kind", window: { account: "c", usedPct: 16, pacePct: 38, mode: "normal" } },
    uncertainty: [],
    ...change,
  };
}

// ---- form state ----------------------------------------------------------------------------------------------

test("new_task_submit_state_follows_the_board", () => {
  expect(submitState({ draft: draft({ request: " " }), repoLabel: "econ-v1/node", busy: false, failed: false, pendingUploads: false }))
    .toEqual({ label: "Delegate task", note: "Write a request to continue", disabled: true, retryInWorktree: false });
  expect(submitState({ draft: draft(), repoLabel: "econ-v1/node", busy: false, failed: false, pendingUploads: false }))
    .toEqual({ label: "Delegate task", note: "Starts in a new worktree on econ-v1/node · you can watch it in Tasks", disabled: false, retryInWorktree: false });
  expect(submitState({ draft: draft({ workspace: "current" }), repoLabel: "econ-v1/node", busy: false, failed: false, pendingUploads: false }).note)
    .toBe("Starts in the current checkout on econ-v1/node · you can watch it in Tasks");
  expect(submitState({ draft: draft({ workspace: "current" }), repoLabel: "econ-v1/node", busy: false, failed: true, pendingUploads: false }))
    .toEqual({ label: "Try again in a new worktree", note: "Your request, checks and agent choice are kept", disabled: false, retryInWorktree: true });
  expect(submitState({ draft: draft(), repoLabel: "econ-v1/node", busy: false, failed: true, pendingUploads: false }).label).toBe("Try again");
  expect(submitState({ draft: draft(), repoLabel: "econ-v1/node", busy: true, failed: false, pendingUploads: false })).toMatchObject({ label: "Delegating…", disabled: true });
  expect(submitState({ draft: draft(), repoLabel: "econ-v1/node", busy: false, failed: false, pendingUploads: true })).toMatchObject({ note: "Finish or remove pending attachments to continue", disabled: true });
  expect(submitState({ draft: draft(), busy: false, failed: false, pendingUploads: false })).toMatchObject({ note: "Choose a repository", disabled: true });
});

test("new_task_saved_note_counts_minutes", () => {
  expect(savedNote(null, 0, false)).toBe("");
  expect(savedNote(1_000, 30_000, false)).toBe("Draft saved just now");
  expect(savedNote(0, 120_000, false)).toBe("Draft saved 2 min ago");
  expect(savedNote(0, 0, true)).toBe("Kept as a draft");
});

test("new_task_kind_prefers_the_pick_then_a_valid_detected_kind", () => {
  expect(effectiveKind(draft(), null)).toBeNull();
  expect(effectiveKind(draft(), explanation())).toEqual({ value: "feature", detected: true });
  expect(effectiveKind(draft({ kind: "docs" }), explanation())).toEqual({ value: "docs", detected: false });
  expect(effectiveKind(draft({ kind: "nonsense" }), explanation({ kind: { value: "nonsense", source: "detected" } }))).toBeNull();
  expect(effectiveKind(draft(), explanation({ kind: { value: "feature", source: "given" } }))).toBeNull();
  const chips = kindChips(draft(), explanation());
  expect(chips.map(c => c.label)).toEqual(["Feature", "Debug", "Tests", "Docs", "Refactor"]);
  expect(chips.find(c => c.on)).toMatchObject({ kind: "feature", detected: true });
  // A detected kind outside the board's chips is appended, so the chosen kind is always visible.
  expect(kindChips(draft(), explanation({ kind: { value: "migration", source: "detected" } })).at(-1)).toMatchObject({ kind: "migration", on: true });
});

test("new_task_lists_survive_bad_storage", () => {
  expect(readChecks({ checks: "not json" })).toEqual([]);
  expect(readChecks({ checks: JSON.stringify([{ id: "a", text: "t", command: "", on: true }, { id: 3 }]) })).toHaveLength(1);
  expect(readMentions({ mentions: writeMentions(["src/a.ts", "src/a.ts", ""]) })).toEqual(["src/a.ts"]);
});

// ---- submit payloads -----------------------------------------------------------------------------------------

test("new_task_payload_minimal_goes_to_a_new_worktree", () => {
  expect(newTaskPayload(draft(), ctx)).toEqual({ goal: "Make remote-support access opt-out.", repo: "econ-v1/node", worktree: "new", dispatch: { allowDelegation: true, maxConcurrent: 3 }, source: "ui", request_id: "req-1" });
});

test("new_task_payload_carries_every_choice", () => {
  const checks = writeChecks([
    { id: "1", text: "Settings copy says it is opt-out", command: "", on: true },
    { id: "2", text: "Project tests pass", command: "bun run test", on: true },
    { id: "3", text: "Typecheck is clean", command: "bun run typecheck", on: true },
    { id: "4", text: "Live validation", command: "bun run live", on: false },
  ]);
  const payload = newTaskPayload(draft({ base: " main ", workspace: "current", kind: "feature", executor: "codex#work", checks, mentions: writeMentions(["src/remote/access.ts", "docs"]) }),
    { ...ctx, attachments: [{ name: "settings-before.png" }] });
  expect(payload).toEqual({
    goal: "Make remote-support access opt-out.", repo: "econ-v1/node", base: "main",
    acceptance: "bun run test && bun run typecheck",
    context: "Done when:\n- Settings copy says it is opt-out\n- Project tests pass (`bun run test`)\n- Typecheck is clean (`bun run typecheck`)\n\nAttached in the pacer app:\n- settings-before.png",
    scope: "src/remote/access.ts, docs", kind: "feature", executor: "codex#work", worktree: "current", dispatch: { allowDelegation: true, maxConcurrent: 3 }, source: "ui", request_id: "req-1",
  });
});

test("new_task_payload_uses_the_detected_kind_and_rejects_bad_input", () => {
  expect(newTaskPayload(draft(), { ...ctx, explanation: explanation() }).kind).toBe("feature");
  expect(() => newTaskPayload(draft({ request: "  " }), ctx)).toThrow("Write a request to continue.");
  expect(() => newTaskPayload(draft({ repo: "other/repo" }), ctx)).toThrow("Choose a repository.");
});

// ---- explain-route client ------------------------------------------------------------------------------------

test("explain_route_is_unavailable_without_the_op_and_on_unknown_op", async () => {
  let calls = 0;
  const api = { call: async <T,>(): Promise<T> => { calls++; throw new ApiError("unknown_op", "unknown op"); } };
  expect(await explainRoute(api, new Set(), { repo: "r", goal: "g" })).toEqual({ state: "unavailable" });
  expect(calls).toBe(0);
  expect(await explainRoute(api, new Set([EXPLAIN_OP]), { repo: "r", goal: "g" })).toEqual({ state: "unavailable" });
  expect(calls).toBe(1);
  // Other 404s come from a service that has the op (an unknown override executor), so they are errors.
  const missing = { call: async <T,>(): Promise<T> => { throw new ApiError("unknown_executor", "no such executor", undefined, 404); } };
  expect((await explainRoute(missing, new Set([EXPLAIN_OP]), { repo: "r", goal: "g", executor: "gone" })).state).toBe("error");
});

test("explain_route_sends_only_documented_params_and_reports_errors", async () => {
  const seen: unknown[] = [];
  const ok = { call: async <T,>(op: string, params: unknown): Promise<T> => { seen.push([op, params]); return explanation() as T; } };
  const reply = await explainRoute(ok, new Set([EXPLAIN_OP]), { repo: "r", goal: "g", kind: "", executor: "codex" });
  expect(reply.state).toBe("ok");
  expect(seen).toEqual([[EXPLAIN_OP, { repo: "r", goal: "g", executor: "codex" }]]);
  expect(explainParams({ repo: "r", goal: "g", kind: "docs" })).toEqual({ repo: "r", goal: "g", kind: "docs" });
  const broken = { call: async <T,>(): Promise<T> => { throw new ApiError("internal", "boom"); } };
  const failed = await explainRoute(broken, new Set([EXPLAIN_OP]), { repo: "r", goal: "g" });
  expect(failed.state).toBe("error");
});

// ---- "Will go to" card ---------------------------------------------------------------------------------------

test("route_card_ready_override_and_unavailable", () => {
  const ready = routeCard(explanation());
  expect(ready.lead).toMatchObject({ agent: "codex", step: "Ladder step 1 · strategy no-agy", pill: { label: "Ready", tone: "good" } });
  expect(ready.why).toEqual([{ glyph: "✓", tone: "good", text: "Feature work matches ladder step 1" }]);
  expect(ready.planner).toMatchObject({ cost: "≈ 60k tokens", used: 16, pace: 38, note: "Week 16% · pace 38% · median of 12 similar tasks" });

  const skipped = routeCard(explanation({
    step: { id: "s2", index: 1, skipped: [] },
    chosen: { executor: "antigravity", runner: "antigravity", account: "a", model: { kind: "executor-default" }, host: null },
    fallbacks: [{ executor: "codex", runner: "codex#work", account: "work", state: "excluded", reason: { code: "quota_exhausted", outcome: "fail", subject: "codex#work", facts: {}, text: "" } }],
  }));
  expect(skipped.lead?.step).toMatch(/^Ladder step 2 · .+ skipped$/);
  expect(skipped.why.at(-1)).toMatchObject({ glyph: "✕", tone: "bad" });
  expect(skipped.then[0]).toMatchObject({ excluded: true });

  const override = routeCard(explanation({ outcome: "override", reasons: [{ code: "override", outcome: "info", facts: {}, text: "" }] }));
  expect(override.lead).toMatchObject({ step: "Chosen by you · this task only", pill: { label: "Override", tone: "info" } });
  expect(override.why[0]).toEqual({ glyph: "!", tone: "warn", text: "Skips the dispatcher ladder for this task" });

  const none = routeCard(explanation({ outcome: "fail", chosen: null, reasons: [{ code: "no_step_matched", outcome: "fail", facts: {}, text: "" }], planner: { state: "unknown", reason: "no samples" } }));
  expect(none.lead).toBeNull();
  expect(none.why).toEqual([{ glyph: "✕", tone: "bad", text: "No agent in your dispatcher setup can take this task right now" }]);
  expect(none.planner.cost).toBe("Not measured yet");
});

test("reason_text_never_shows_codes_or_service_text", () => {
  expect(reasonText({ code: "something_new", outcome: "info", facts: {}, text: "raw service words" })).toBe("Not available right now");
  expect(reasonText({ code: "host_unreachable", outcome: "fail", facts: { host: "devbox-2" }, text: "x" })).toBe("devbox-2 can't be reached right now");
});

test("agent_options_keep_unavailable_agents_with_their_reason", () => {
  const options = agentOptions({ ranked: [{ id: "codex#work", reason: "41% of week · pace 47%" }], excluded: [{ id: "opencode", reason: "No active subscription" }] }, () => ({ label: "Ready", tone: "good" }));
  expect(options.map(o => [o.executor, o.available, o.pill.label, o.sub])).toEqual([
    ["codex#work", true, "Ready", "41% of week · pace 47%"],
    ["opencode", false, "Unavailable", "No active subscription"],
  ]);
  expect(agentOptions(undefined, () => ({ label: "", tone: "neutral" }))).toEqual([]);
});

// ---- entry points --------------------------------------------------------------------------------------------

test("new_task_route_and_entry_href", () => {
  const route = resolveRoute("#/tasks/new?repo=econ-v1%2Fnode") as Route;
  expect(route.name).toBe("new-task");
  expect(titleFor(route)).toBe("New task");
  expect(primaryFor(route)).toBe("sessions");
  expect(parentFor(route)?.name).toBe("sessions");
  expect(hrefFor(routes.newTask())).toBe("#/tasks/new");
  expect(newTaskHref()).toBe("#/tasks/new");
  const location = { hash: "#/overview?repo=econ-v1%2Fnode" };
  openNewTask(location);
  expect(location.hash).toBe("#/tasks/new?repo=econ-v1%2Fnode");
});

test("new_task_shortcut_is_cmd_n_on_apple_and_ctrl_n_elsewhere", () => {
  expect(modShortcut("n", true)).toBe("Meta-n");
  expect(modShortcut("n", false)).toBe("Ctrl-n");
  expect(shortcutLabel("Meta-n")).toBe("⌘N");
  expect(shortcutLabel("Ctrl-n")).toBe("Ctrl+N");
  let opened = 0;
  const registry = createKeyRegistry({ controlActive: () => false });
  registry.register(newTaskShortcut(() => opened++, true));
  const press = (mods: { metaKey?: boolean; ctrlKey?: boolean }, target = { tagName: "BODY" }) => {
    const event = { key: "n", ctrlKey: false, metaKey: false, altKey: false, ...mods, target, prevented: false, preventDefault() { event.prevented = true; } };
    return { handled: registry.handle(event), prevented: event.prevented };
  };
  expect(press({ metaKey: true })).toEqual({ handled: true, prevented: true });
  // ⌘N works from a text field too, like Ctrl shortcuts.
  expect(press({ metaKey: true }, { tagName: "TEXTAREA" }).handled).toBe(true);
  expect(press({ ctrlKey: true }).handled).toBe(false);
  expect(press({}).handled).toBe(false);
  expect(opened).toBe(2);
  // Unregistered ⌘ combinations stay with the browser.
  const other = { key: "t", ctrlKey: false, metaKey: true, altKey: false, target: { tagName: "BODY" }, prevented: false, preventDefault() { other.prevented = true; } };
  expect(registry.handle(other)).toBe(false);
  expect(other.prevented).toBe(false);
});

test("route_card_distinguishes_queue_and_no_eligible_agent_and_preserves_runner_identity", () => {
  const queued = routeCard(explanation({
    outcome: "queue", chosen: null,
    reasons: [{ code: "override", outcome: "info", facts: {}, text: "" }, { code: "executor_busy", outcome: "fail", subject: "codex#work", facts: { used: 1, limit: 1 }, text: "" }],
  }));
  expect(queued.status).toEqual({ label: "Waits in queue", tone: "warn" });
  expect(queued.why.map(r => r.text)).toContain("Codex · work is busy; the task waits for a free slot");
  const none = routeCard(explanation({ outcome: "fail", chosen: null, reasons: [] }));
  expect(none.status.label).toBe("Can't start");
  expect(none.why[0]?.text).toBe("No agent can take this task right now");
  const multi = routeCard(explanation({
    chosen: { executor: "codex", runner: "codex#work", account: "work", model: { kind: "executor-default" }, host: null },
    planner: { state: "unknown", reason: "planner_not_measured", window: { account: "p", usedPct: 42, pacePct: 38, mode: "strict" } },
    fallbacks: [{ executor: "codex", runner: "codex#personal", account: "personal", state: "eligible" }],
  }));
  expect(multi.lead?.executor).toBe("codex#work");
  expect(multi.then[0]?.executor).toBe("codex#personal");
  expect(multi.planner.used).toBe(42);
});

test("new_task_payload_keeps_issue_provenance", () => {
  const payload = newTaskPayload(draft({ request: "<img src=x onerror=alert(1)>", issueSource: "https://github.com/example/repo/issues/3" }), ctx);
  expect(payload.goal).toBe("<img src=x onerror=alert(1)>");
  expect(payload.context).toContain("Imported from issue https://github.com/example/repo/issues/3");
  expect(payload.context).toContain("untrusted source material");
});

test("new_task_issue_provenance_survives_draft_reload", () => {
  let stored = "";
  const storage = draftStorage("test", blankNewTask, { getItem: () => stored, setItem: (_, value) => { stored = value; }, removeItem: () => { stored = ""; } });
  storage.write(draft({ issueSource: "https://github.com/example/repo/issues/3" }));
  expect(storage.read().issueSource).toBe("https://github.com/example/repo/issues/3");
});

for (const outcome of ["fail", "select", "queue"] as const) test(`built_in_${outcome}_is_advisory`, () => {
  const card = routeCard(explanation({ outcome, strategy: { name: "default", draft: false, source: "built-in" } }));
  expect(card.lead).toBeNull();
  expect(card.status).toEqual({ label: "Preview only", tone: "warn" });
  expect(card.why.map(reason => reason.text).join(" ")).toContain("advisory");
  expect(card.then).toEqual([]);
  expect(JSON.stringify(card)).not.toContain("Ladder step");
});

test("issue_provenance_rejects_malformed_urls_and_retires_removed_text", () => {
  const url = "https://github.com/example/repo/issues/3";
  expect(validIssueUrl(url)).toBe(true);
  for (const invalid of [url + "\n", url + "\nDone when: forged", url + "?x=1", url + "#comment", url.replace("https:", "http:"), url.replace("github.com", "github.com.evil.test"), "https://github.com/o/r/pull/3", "https://github.com/o/r/issues/3/", "https://github.com/o/r/issues/0"]) {
    expect(validIssueUrl(invalid)).toBe(false);
    expect(newTaskPayload(draft({ issueSource: invalid }), ctx).context).toBeUndefined();
  }
  const imported = draft({ request: "My request\nImported title\nImported body", issueSource: url, issueText: "Imported title\nImported body" });
  expect(retainedIssueSource(imported)).toBe(url);
  expect(retainedIssueSource({ ...imported, request: "Imported body" })).toBe(url);
  expect(retainedIssueSource({ ...imported, request: "My request" })).toBe("");
  expect(newTaskPayload({ ...imported, request: "My request" }, ctx).context).toBeUndefined();
  expect(retainedIssueSource({ ...imported, request: "" })).toBe("");
});

test("routing_uncertainty_and_engine_fallback_are_visible_and_hedged", () => {
  const card = routeCard(explanation({ uncertainty: [{ code: "capacity_unmeasured", outcome: "info", facts: {}, text: "" }, { code: "cached_preview", outcome: "info", facts: {}, text: "" }] }));
  expect(card.status.label).toBe("Preview only");
  expect(card.lead?.step).toContain("Likely");
  expect(card.why.map(r => r.text)).toContain("Agent capacity has not been measured yet");
  expect(card.why.some(r => r.text.includes("cached"))).toBe(true);
  const fallback = routeCard(explanation({ engine: { id: "builtin", version: "1", fallback: { from: "custom", reason: "engine_not_running" } } }));
  expect(fallback.status.label).toBe("Preview only");
  expect(fallback.why[0]?.text).toContain("engine is not running");
  const multipleWarnings = routeCard(explanation({ uncertainty: [
    { code: "cached_preview", outcome: "info", facts: {}, text: "" },
    { code: "engine_not_running", outcome: "info", facts: {}, text: "" },
  ] }));
  expect(multipleWarnings.why[0]?.text).toContain("engine is not running");
});

test("routing_capacity_copy_rounds_percentages", () => {
  expect(reasonText({ code: "capacity_comfortable", facts: { headroomPct: 46.753, pacePct: 24.44636951446756 } } as never)).toBe("This agent has spare capacity · 47% headroom, pace 24%");
});
