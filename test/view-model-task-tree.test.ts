import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import { scopedTaskTree, taskTree, treeSummary, workTasks, type TaskNodeView, type TreeSnapshot, type TreeTask } from "../src/view-model/task-tree";
import { taskStatus } from "../src/view-model/words";

const now = 1800000000;
const snapshot = () => structuredClone(fixture) as unknown as TreeSnapshot;
const find = (nodes: TaskNodeView[], id: string): TaskNodeView | undefined => {
  for (const node of nodes) { if (node.id === id) return node; const hit = find(node.children, id); if (hit) return hit; }
  return undefined;
};

test("waiting_root_gets_warn_attention", () => {
  const snap = snapshot();
  snap.tasks.find(t => t.id === "t-0421")!.state = "needs_input";
  snap.attention!.push({ ...snap.attention!.find(item => item.id === "review:t-0412")!, id: "question:t-0421", kind: "question", taskId: "t-0421" });
  const nodes = taskTree(snap, { now });
  expect(find(nodes, "t-0421")!.attention).toBe("warn");
  expect(find(nodes, "t-0421")!.attentionLabel).toBe("Needs your answer");
  // A review request is a decision waiting on the user.
  expect(find(nodes, "t-0412")!.attention).toBe("warn");
  expect(find(nodes, "t-0412")!.attentionLabel).toBe("Review requested");
  expect(find(nodes, "t-0420")!.attention).toBe("none");
  expect(find(nodes, "t-0420")!.attentionLabel).toBeUndefined();
});

test("failed_checks_root_gets_bad_attention", () => {
  const snap = snapshot();
  const task = snap.tasks.find(t => t.id === "t-0415")!;
  task.acceptanceState = "failed";
  snap.attention = snap.attention!.filter(item => item.taskId !== "t-0415");
  snap.attention.push({ ...snap.attention.find(item => item.id === "failed:t-0409")!, id: "failed:t-0415", taskId: "t-0415" });
  const nodes = taskTree(snap, { now });
  expect(find(nodes, "t-0415")!.attention).toBe("bad");
  expect(find(nodes, "t-0415")!.attentionLabel).toBe("Checks failed");
  expect(find(nodes, "t-0409")!.attention).toBe("bad");
});

test("roots_order_attention_then_running_then_recent", () => {
  const ids = taskTree(snapshot(), { now }).map(node => node.id);
  // Problems before decisions, then running and queued work, then the rest by recency.
  expect(ids).toEqual(["t-0409", "t-0415", "t-0412", "t-0420", "t-0421", "t-0422", "t-0405", "t-0403"]);
  const nodes = taskTree(snapshot(), { now });
  expect(nodes.filter(node => node.active).map(node => node.id)).toEqual(["t-0420", "t-0421", "t-0422"]);
});

test("unknown_tokens_omitted", () => {
  const snap = snapshot();
  const withTokens = snap.tasks.find(t => t.id === "t-0405")!;
  withTokens.tokens = { total: 1234567, lowerBound: false, measuredAttempts: 1, partialAttempts: 0 };
  snap.tasks.find(t => t.id === "t-0403")!.tokens = { total: 0, lowerBound: true, measuredAttempts: 0, partialAttempts: 0 };
  snap.tasks.find(t => t.id === "t-0412")!.tokens = { total: 42000, lowerBound: true, measuredAttempts: 0, partialAttempts: 1 };
  const nodes = taskTree(snap, { now });
  expect(find(nodes, "t-0420")!.tokens).toBeUndefined();
  expect(find(nodes, "t-0403")!.tokens).toBeUndefined();
  expect(find(nodes, "t-0405")!.tokens).toBe("1.2M tokens");
  expect(find(nodes, "t-0412")!.tokens).toBe("≥ 42k tokens");
  for (const node of nodes) expect(node.tokens ?? "").not.toMatch(/^0\b/);
});

test("no_pr_fact_omits_pr_item", () => {
  const snap = snapshot();
  snap.tasks.find(t => t.id === "t-0412")!.pr = { number: 412 };
  const nodes = taskTree(snap, { now });
  expect(find(nodes, "t-0420")!.meta.some(item => item.icon === "pr")).toBe(false);
  expect(find(nodes, "t-0412")!.meta.find(item => item.icon === "pr")?.text).toBe("PR #412");
  // Change counts appear only where pacer measured them.
  expect(find(nodes, "t-0420")!.meta.find(item => item.icon === "files")?.text).toBe("6 files · 2 commits");
  expect(find(nodes, "t-0409")!.meta.some(item => item.icon === "files")).toBe(false);
  for (const node of nodes) for (const item of node.meta) expect(item.text).not.toMatch(/^(0|—)$/);
});

test("children_follow_parent_id", () => {
  const snap = snapshot();
  snap.tasks.find(t => t.id === "t-0421")!.parentId = "t-0420";
  snap.tasks.find(t => t.id === "t-0422")!.parentId = "t-0420";
  snap.tasks.find(t => t.id === "t-0403")!.parentId = "t-missing";
  const nodes = taskTree(snap, { now });
  const root = nodes.find(node => node.id === "t-0420")!;
  expect(root.children.map(child => child.id)).toEqual(["t-0421", "t-0422"]);
  expect(nodes.some(node => node.id === "t-0421")).toBe(false);
  // A child whose parent is not loaded stays reachable as a root.
  expect(nodes.some(node => node.id === "t-0403")).toBe(true);
  // Agents roll up from children without repeats.
  expect(root.agents).toEqual(["codex", "claude-code", "agy"]);
});

test("child_attention_rolls_up_to_root", () => {
  const snap = snapshot();
  snap.tasks.find(t => t.id === "t-0409")!.parentId = "t-0405";
  const nodes = taskTree(snap, { now });
  const root = nodes.find(node => node.id === "t-0405")!;
  expect(root.attention).toBe("bad");
  expect(nodes[0]!.id).toBe("t-0405");
});

test("labels_match_status_vocabulary", () => {
  const snap = snapshot();
  const nodes = taskTree(snap, { now });
  for (const task of snap.tasks) {
    const node = find(nodes, task.id)!;
    const status = taskStatus(task);
    expect(node.state.label).toBe(status.label);
    expect(node.state.tone).toBe(status.tone);
    expect(node.state.live).toBe(task.state === "running");
  }
});

test("host_and_title_use_public_copy", () => {
  const nodes = taskTree(snapshot(), { now });
  expect(find(nodes, "t-0420")!.host).toEqual({ name: "devbox", kind: "remote" });
  expect(find(nodes, "t-0421")!.host).toEqual({ name: "Local Mac", kind: "local" });
  expect(find(nodes, "t-0420")!.title).toBe("Add SSH keepalive to remote runs");
  expect(find(nodes, "t-0420")!.meta.find(item => item.icon === "time")?.text).toBe("running for 14m");
});

test("extra_tasks_merge_by_id_without_duplicates", () => {
  const snap = snapshot();
  const older = { ...snap.tasks.find(t => t.id === "t-0403")!, id: "t-0390", updatedAt: 1799900000 };
  const nodes = taskTree(snap, { now, extra: [older, snap.tasks[0]!] });
  expect(nodes.map(node => node.id).filter(id => id === "t-0420")).toHaveLength(1);
  expect(nodes.at(-1)!.id).toBe("t-0390");
});

test("unknown_host_omitted", () => {
  const snap = snapshot();
  delete (snap.tasks.find(t => t.id === "t-0405") as { host?: string | null }).host;
  const nodes = taskTree(snap, { now });
  expect(find(nodes, "t-0422")!.host).toBeUndefined();
  expect(find(nodes, "t-0405")!.host).toBeUndefined();
  expect(find(nodes, "t-0409")!.host).toEqual({ name: "Local Mac", kind: "local" });
});

test("review_outcome_and_unknown_time_follow_facts", () => {
  const snap = snapshot();
  snap.tasks.find(t => t.id === "t-0409")!.updatedAt = 0;
  const nodes = taskTree(snap, { now });
  expect(find(nodes, "t-0405")!.meta.find(item => item.icon === "review")).toEqual({ icon: "review", text: "Accepted", tone: "good" });
  expect(find(nodes, "t-0403")!.meta.find(item => item.icon === "review")?.text).toBe("Rejected");
  expect(find(nodes, "t-0420")!.meta.some(item => item.icon === "review")).toBe(false);
  expect(find(nodes, "t-0409")!.meta.some(item => item.icon === "time")).toBe(false);
});

test("scoped_tree_applies_repo_dismissal_and_needs_you_rules", () => {
  const snap = snapshot() as unknown as Parameters<typeof scopedTaskTree>[0];
  snap.tasks.find(t => t.id === "t-0422")!.dismissed = true;
  // A review that was already decided no longer needs the user.
  snap.tasks.find(t => t.id === "t-0415")!.review = { accepted: true, kind: null, note: null, at: 1799999200 };
  const all = scopedTaskTree(snap, { repo: null }, { now });
  expect(all.some(node => node.id === "t-0422")).toBe(false);
  expect(find(all, "t-0415")!.attention).toBe("none");
  expect(find(all, "t-0412")!.attention).toBe("warn");
  const api = scopedTaskTree(snap, { repo: "github.com/acme/api" }, { now });
  expect(api.every(node => snap.tasks.find(t => t.id === node.id)!.repo?.key === "github.com/acme/api")).toBe(true);
});

test("attention_follows_needs_you_not_raw_state", () => {
  // A failure the user already resolved is gone from Needs you, so its card is not tinted and does not sort first.
  const snap = snapshot();
  snap.attention = snap.attention!.filter(item => item.taskId !== "t-0409");
  snap.tasks.find(t => t.id === "t-0409")!.resolved = "worktree removed";
  const nodes = taskTree(snap, { now });
  expect(find(nodes, "t-0409")!.attention).toBe("none");
  expect(find(nodes, "t-0409")!.attentionLabel).toBeUndefined();
  expect(nodes[0]!.id).not.toBe("t-0409");
});

test("without_a_needs_you_list_state_is_the_evidence", () => {
  const snap = snapshot();
  const tasks = snap.tasks.map(t => t.id === "t-0421" ? { ...t, state: "needs_input" } : t.id === "t-0415" ? { ...t, acceptanceState: "failed" as const } : t);
  const nodes = taskTree({ tasks }, { now });
  expect(find(nodes, "t-0421")!.attention).toBe("warn");
  expect(find(nodes, "t-0409")!.attention).toBe("bad");
  expect(find(nodes, "t-0415")!.attentionLabel).toBe("Checks failed");
  // Decided or resolved work needs nothing.
  expect(find(nodes, "t-0405")!.attention).toBe("none");
  expect(taskTree({ tasks: tasks.map(t => t.id === "t-0409" ? { ...t, resolved: "retried" } : t) }, { now }).find(n => n.id === "t-0409")!.attention).toBe("none");
});

test("detail_parent_link_survives_snapshot_merge", () => {
  const snap = snapshot();
  const detail = { ...snap.tasks.find(t => t.id === "t-0421")!, parentId: "t-0420" };
  const nodes = taskTree(snap, { now, extra: [detail] });
  expect(nodes.find(n => n.id === "t-0420")!.children.map(c => c.id)).toEqual(["t-0421"]);
  expect(nodes.some(n => n.id === "t-0421")).toBe(false);
});

test("pinned_task_survives_scope_filters", () => {
  const snap = snapshot() as unknown as Parameters<typeof scopedTaskTree>[0];
  snap.tasks.find(t => t.id === "t-0420")!.dismissed = true;
  const other = snap.tasks.find(t => t.repo?.key !== "github.com/acme/api")!;
  const scope = { repo: "github.com/acme/api" };
  expect(scopedTaskTree(snap, scope, { now }).some(n => n.id === "t-0420")).toBe(false);
  expect(scopedTaskTree(snap, scope, { now, pinned: "t-0420" }).some(n => n.id === "t-0420")).toBe(true);
  expect(scopedTaskTree(snap, scope, { now, extra: [other], pinned: other.id }).some(n => n.id === other.id)).toBe(true);
});

const walk = (nodes: TaskNodeView[]): TaskNodeView[] => nodes.flatMap(node => [node, ...walk(node.children)]);

test("every_attention_tint_has_words", () => {
  const snap = snapshot();
  snap.tasks.find(t => t.id === "t-0409")!.parentId = "t-0420";
  const nodes = taskTree(snap, { now });
  const root = nodes.find(node => node.id === "t-0420")!;
  expect(root.attention).toBe("bad");
  expect(root.attentionLabel).toBe("Subtask: Failed");
  for (const node of walk(nodes)) if (node.attention !== "none") expect(node.attentionLabel).toBeTruthy();
});

test("attention_tone_matches_vocabulary", () => {
  const snap = snapshot();
  // A problem-severity item whose words are a warning (Incomplete) is tinted as a warning, like its status everywhere else.
  snap.tasks.find(t => t.id === "t-0409")!.state = "partial";
  snap.tasks.find(t => t.id === "t-0421")!.state = "needs_input";
  snap.attention!.push({ ...snap.attention!.find(item => item.id === "failed:t-0409")!, id: "question:t-0421", kind: "question", severity: "blocked", taskId: "t-0421" });
  const nodes = taskTree(snap, { now });
  for (const node of walk(nodes)) {
    if (node.attention === "none" || !node.attentionLabel || node.attentionLabel.startsWith("Subtask: ")) continue;
    const tone = [...Object.values({ a: taskStatus({ state: "failed" }), b: taskStatus({ state: "needs_input" }), c: taskStatus({ state: "partial" }) })]
      .find(status => status.label === node.attentionLabel)?.tone;
    if (tone) expect(node.attention).toBe(tone === "bad" ? "bad" : "warn");
  }
  expect(find(nodes, "t-0421")!.attention).toBe("warn");
  expect(find(nodes, "t-0409")!.attention).toBe("warn");
  expect(find(nodes, "t-0409")!.attentionLabel).toBe("Incomplete");
});

test("orphan_subtask_says_so", () => {
  const snap = snapshot();
  snap.tasks.find(t => t.id === "t-0403")!.parentId = "t-missing";
  const nodes = taskTree(snap, { now });
  expect(find(nodes, "t-0403")!.meta[0]).toEqual({ icon: "routing", text: "Subtask" });
  expect(find(nodes, "t-0405")!.meta.some(item => item.text === "Subtask")).toBe(false);
});

test("stuck_run_gets_attention_words_not_its_calm_status", () => {
  const snap = snapshot();
  snap.attention!.push({ ...snap.attention!.find(item => item.id === "review:t-0412")!, id: "stuck:t-0420", kind: "stuck", severity: "blocked", taskId: "t-0420" });
  const nodes = taskTree(snap, { now });
  const stuck = find(nodes, "t-0420")!;
  expect(stuck.state.label).toBe("Editing");
  expect(stuck.attention).toBe("warn");
  expect(stuck.attentionLabel).toBe("Idle");
  // The pill is hidden only when it repeats the status, so a tint without its own words cannot occur.
  for (const node of walk(nodes)) if (node.attention !== "none" && node.attentionLabel === node.state.label) expect(node.state.tone).toBe(node.attention);
  // Blocked work sorts ahead of review decisions that share its tint.
  const ids = nodes.map(node => node.id);
  expect(ids.indexOf("t-0420")).toBeLessThan(ids.indexOf("t-0415"));
  expect(ids.indexOf("t-0409")).toBeLessThan(ids.indexOf("t-0420"));
});

const plain = (id: string, over: Partial<TreeTask> = {}): TreeTask => ({ id, goal: id, title: id, state: "done", executor: null, backend: null, worktree: null, updatedAt: 1, ...over });
const own = (total: number, lowerBound = false) => ({ total, lowerBound, measuredAttempts: 1, partialAttempts: 0 });

test("tokens_roll_up_through_three_levels_once_and_carry_the_lower_bound", () => {
  const nodes = taskTree({ tasks: [
    plain("root", { tokens: own(100) }), plain("child", { parentId: "root", tokens: own(50) }), plain("grand", { parentId: "child", tokens: own(25, true) }),
  ] }, { now });
  const root = find(nodes, "root")!;
  expect(root.tokens).toBe("≥ 175 tokens");
  expect(root.tokenCount).toBe(175);
  expect(find(nodes, "child")!.tokens).toBe("≥ 75 tokens");
  expect(find(nodes, "grand")!.tokens).toBe("≥ 25 tokens");
});

test("summary_counts_roots_subtasks_and_measured_tokens_only", () => {
  const withTokens = taskTree({ tasks: [plain("a", { tokens: own(1200) }), plain("b", { parentId: "a", tokens: own(300) }), plain("c")] }, { now });
  expect(treeSummary(withTokens, now)).toEqual({ roots: 2, subtasks: 1, tokens: "1.5k tokens", period: expect.stringMatching(/^since /) });
  expect(treeSummary(taskTree({ tasks: [plain("x", { updatedAt: now - 3600 })] }, { now }), now)).toEqual({ roots: 1, subtasks: 0, period: "this week" });
  expect(treeSummary(taskTree({ tasks: [plain("x", { updatedAt: 0 })] }, { now }), now)).toEqual({ roots: 1, subtasks: 0 });
});

test("merge_keeps_branch_parent_and_tokens_from_work_rows_when_the_snapshot_lacks_them", () => {
  const rows = [{ id: "t-1", parentId: null, rootId: "t-1", depth: 0, title: "t-1", state: "done", executor: null, rev: 1, branch: "pacer/t-1", tokens: own(900) },
    { id: "t-2", parentId: "t-1", rootId: "t-1", depth: 1, title: "t-2", state: "done", executor: null, rev: 1 }];
  const nodes = taskTree({ tasks: [plain("t-1", { updatedAt: 5 }), plain("t-2", { updatedAt: 6 })] }, { now, extra: workTasks(rows) });
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.branch).toBe("pacer/t-1");
  expect(nodes[0]!.children.map(child => child.id)).toEqual(["t-2"]);
  expect(nodes[0]!.tokens).toBe("900 tokens");
});

test("work_rows_keep_their_review_so_old_roots_land_in_accepted_or_stopped", () => {
  const row = (id: string, accepted: boolean) => ({ id, parentId: null, rootId: id, depth: 0, title: id, state: "done", executor: null, rev: 1, review: { accepted, kind: null, note: null, at: 1 } });
  const nodes = taskTree({ tasks: [] }, { now, extra: workTasks([row("ok", true), row("no", false)]) });
  expect(Object.fromEntries(nodes.map(node => [node.id, node.bucket]))).toEqual({ ok: "accepted", no: "stopped" });
});

test("a_settled_root_with_a_running_subtask_counts_as_running", () => {
  const nodes = taskTree({ tasks: [plain("root", { state: "done" }), plain("kid", { parentId: "root", state: "running" })] }, { now });
  expect(nodes[0]!.bucket).toBe("running");
});
