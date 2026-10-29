import source from "./ui/snapshot.json";
import type { ClientSnapshot, ClientTask } from "../../src/view-model/snapshot";
import type { AttentionItem, ExecutorRow } from "../../src/api/read-model/types";
import { eligibility } from "./eligibility";

/** Sample values from Tray.dc.html, expressed as service snapshots. */
export function trayBoard(state: "busy" | "clear" | "paused" | "dark"): ClientSnapshot {
  const snapshot = structuredClone(source) as unknown as ClientSnapshot;
  const at = Date.parse("2026-10-29T12:00:00+07:00") / 1000;
  const clear = state === "clear", paused = state === "paused";
  const row = (id: string, agent: string, usedPct: number | null, rank: ExecutorRow["rank"]): ExecutorRow => ({
    id, agent, account: id, host: null, model: null, rank, enabled: true, state: "ready", tone: "good", sub: "Eligible",
    eligibility: eligibility(), usedPct, pacePct: 38, slots: { used: 0, max: 3 }, lastCheck: null, recentFailures: 0, next: false,
  });
  const task = (id: string, title: string, phase: string, minutes: number, repo: string): ClientTask => ({
    id, title, goal: title, state: "running", executor: "codex", backend: null, worktree: null, updatedAt: at,
    attemptStartedAt: at - minutes * 60, progress: { phase, lastOutputAt: at, files: 0, commits: 0, logBytes: 0 }, repo: { key: repo, label: repo, path: `$HOME/${repo}` },
  });
  const running = [task("run-1", "Make remote-support access mode opt-out", "working", 12, "econ-v1/node")];
  if (clear) running.splice(1, 1, { ...running[0]!, id: "last-review", state: "done", review: { accepted: true, kind: null, note: null, at: at - 18 * 60 } });
  const needs = [
    { kind: "question", title: "ota: stale plan shown as the current update", detail: "Codex is waiting for your answer · 38 min", label: "Answer", repo: "econ-v1/node-app-ota" },
    { kind: "failed", title: "runner-forge: GitHub App authentication", detail: "Checks failed twice on Codex", label: "Retry on Antigravity", repo: "econ-v1/runner-forge" },
    { kind: "review", title: "Browser-validate the Client Node PWA drop", detail: "Checks passed · ready for review", label: "Review", repo: "econ-v1/node" },
  ] as const;
  return { ...snapshot, at,
    planner: { ...snapshot.planner!, runner: "claude-code", agent: "claude-code", usedPct: 16, pacePct: 38, verdict: "behind", resetsAt: Date.parse("2026-10-30T12:00:00+07:00") / 1000, mode: "relaxed" },
    pause: paused ? { until: at + 3600, by: "app", reason: null } : null,
    tasks: [...(paused ? [] : running), ...(!paused ? [] : [0, 1].map(i => ({ ...task(`queued-${i}`, i ? "Other waiting task" : "Docs for opt-out support", "working", 0, "pacer"), state: "queued" as const, queue: { reason: "no_slot" as const, since: at, position: i + 1 } })))],
    attention: clear ? [] : needs.slice(0, paused ? 1 : 3).map<AttentionItem>((item, i) => ({ id: `needs-${i}`, kind: item.kind, severity: "problem", title: item.title, detail: item.detail, raisedAt: at - 720, since: at - 720, notify: "all", repo: { key: item.repo, label: item.repo, path: `$HOME/${item.repo}` }, actions: [{ label: item.label, op: item.kind === "failed" ? "task.retry" : "ui.open", params: { id: `needs-${i}`, view: "task", executor: "codex" } }] })),
    counts: { ...snapshot.counts!, attention: clear ? 0 : paused ? 1 : 3, running: paused ? 0 : 1, byRepo: {} },
    today: { ...snapshot.today!, done: clear ? 12 : 9 },
    strategies: [{ name: "no-agy", active: true, summary: "", description: "" }],
    executors: [row("claude-code", "claude-code", 16, "planner"), row("codex", "codex", 81, 1), row("agy", "agy", 22, 2),
      { ...row("opencode#local", "opencode", null, 3), account: "local", paceReason: "unmetered", pacePct: null },
      { ...row("opencode#byteplus", "opencode", null, 4), account: "byteplus", eligibility: undefined, state: "down", reason: "no active subscription" }, { ...row("cursor", "cursor", 0, 4), enabled: false, state: "disabled" }],
    accounts: ["codex", "agy", "opencode#local"].map((name, i) => ({ ...snapshot.accounts![0]!, name, executors: [name], verdict: i === 0 ? "ahead" : "behind" })),
  };
}
