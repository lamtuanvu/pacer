import snapshot from "../ui/snapshot.json";
import taskGet from "../ui/task-get.json";
import settings from "../ui/tui-settings.json";
import { renderDashboard, screenItems } from "../../../src/dashboard/render";
import { SECTIONS } from "../../../src/dashboard/screens/settings";
import { PLAIN_THEME } from "../../../src/dashboard/theme";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { DashData, SettingsData, TaskDetail } from "../../../src/dashboard/screens/types";
import type { RenderOptions } from "../../../src/dashboard/render";
import type { UpdateStatus } from "../../../src/update/desktop/types";
import type { UiState } from "../../../src/dashboard/state";
import type { ThreadDetail } from "../../../src/dashboard/screens/thread";

interface FrameCase extends Pick<RenderOptions, "update" | "connection" | "ops" | "message"> {
  name: string;
  width: number;
  height: number;
  state: Partial<UiState>;
  snapshot?: ClientSnapshot;
  settings?: SettingsData;
  history?: DashData["history"];
  details?: Record<string, { value?: TaskDetail; loading?: boolean; error?: { code: string; message: string; hint?: string } }>;
}

// These inputs and full rendered strings are the TypeScript reference for a future port.
export function corpus() {
  const s = structuredClone(snapshot) as unknown as ClientSnapshot;
  const detail = { ...structuredClone(taskGet), messages: { value: [{ id: "m1", taskId: "t-0412", rootId: "t-0412", from: "task:t-0412", to: "human", kind: "question", body: "Can you check the result?", replyTo: null, requestId: null, status: "delivered", createdAt: 1800000000, deliveredAt: 1800000000, readAt: null, turnId: null }] } } as unknown as ThreadDetail;
  const data = { details: new Map([["t-0412", { value: detail }]]), settings: structuredClone(settings) as unknown as SettingsData };
  const cases: [string, Partial<UiState>][] = [
    ["dashboard", { screen: "home" }],
    ["review", { screen: "review" }],
    ["workspace", { screen: "sessions" }],
    ["thread", { screen: "sessions", selected: { sessions: "session:t-0412" }, focus: "detail" }],
    ["settings", { screen: "settings", section: "accounts", focus: "detail" }],
    ["upgrade", { screen: "settings", section: "updates", focus: "detail" }],
    ...SECTIONS.map(({ id }): [string, Partial<UiState>] => [`settings-${id}`, { screen: "settings", section: id, focus: "detail" }]),
  ];
  const generated: FrameCase[] = cases.flatMap(([name, state]) => [[120, 40], [80, 24], [60, 16], [160, 50]].map(([width, height]) => ({
    name: `${name}-${width}x${height}`, width: width!, height: height!, state,
    ...(name === "upgrade" ? { update: "available" as const } : {}),
  })));
  const add = (name: string, state: Partial<UiState>, extra: Partial<FrameCase> = {}) => {
    for (const [width, height] of [[120, 40], [80, 24]]) generated.push({ name: `${name}-${width}x${height}`, width: width!, height: height!, state, ...extra });
  };
  add("settings-navigation", { screen: "settings", section: "updates", focus: "list" });
  add("review-result", { screen: "review", selected: { review: "review:t-0412" } });
  add("review-result-scroll", { screen: "review", selected: { review: "review:t-0412" }, focus: "detail", scroll: 20 });
  add("workspace-detail", { screen: "sessions", focus: "detail" });
  add("thread-scroll", { screen: "sessions", selected: { sessions: "session:t-0412" }, focus: "detail", scroll: 20 });
  add("dashboard-scoped", { screen: "home", scope: "github.com/acme/api" });
  add("dashboard-offline", { screen: "home" }, { connection: "offline", message: { text: "Service unavailable. R retries.", tone: "bad" } });
  add("dashboard-local", { screen: "home" }, { connection: "local" });
  add("dashboard-connecting", { screen: "home" }, { connection: "connecting" });
  const empty = { ...s, tasks: [], attention: [], executors: [], hosts: [], accounts: [], counts: undefined, planner: undefined, today: undefined };
  for (const screen of ["home", "review", "sessions", "setup"] as const) add(`empty-${screen}`, { screen }, { snapshot: empty });
  const setup = { ...s, setup: { complete: false, ready: false, open: 2, items: [
    { id: "service", title: "Background service", required: true, status: "pending", action: "service.install", detail: "Runs at login" },
    { id: "executor", title: "Add an executor", required: true, status: "failed", detail: "Choose an account" },
    { id: "first", title: "Try a delegation", required: false, status: "pending" },
  ] } } as unknown as ClientSnapshot;
  add("setup", { screen: "setup" }, { snapshot: setup });
  add("setup-redirect", { screen: "home" }, { snapshot: setup });
  for (const section of SECTIONS) {
    const resource = section.needs[0];
    if (resource) for (const state of ["loading", "error"] as const) {
      const settings = { ...data.settings, [resource]: state === "loading" ? { loading: true } : { error: { code: "unavailable", message: "Reading unavailable", hint: "Refresh to retry" } } };
      add(`settings-${section.id}-${state}`, { screen: "settings", section: section.id, focus: "detail" }, { settings });
    }
  }
  for (const reading of ["current", "disabled", "failed", "unchecked"] as const) {
    const update = { current: "0.3.1", latest: null, available: false, ...(reading === "current" ? { latest: "0.3.1" } : {}), ...(reading === "disabled" ? { disabled: true } : {}), ...(reading === "failed" ? { error: "Check failed" } : {}) };
    add(`upgrade-${reading}`, { screen: "settings", section: "updates", focus: "detail" }, { settings: { ...data.settings, update: { value: update } }, update: reading });
  }
  for (const phase of ["idle", "checking", "downloading", "ready", "waiting", "reserved", "installing", "verifying", "complete", "rolling-back", "restored", "error", "recovery-failed"] as const) {
    const status: UpdateStatus = { installationId: "fixture", revision: 1, phase, transactionId: null, autoDownload: true,
      checkedAt: s.at - 30, blockers: [{ kind: "task", id: "t-0420", label: "A task is running" }], downloadedBytes: 37, totalBytes: 100,
      current: "0.3.1", target: "0.3.2", releaseNotes: null, ownership: "managed", error: phase === "error" ? { code: "download_failed", message: "Download failed", hint: "Check the connection" } : null,
      actions: phase === "ready" ? ["restart", "check", "configure"] : phase === "idle" ? ["download", "check", "configure"] : phase === "waiting" ? ["cancel"] : ["check"],
    };
    add(`desktop-upgrade-${phase}`, { screen: "settings", section: "updates", focus: "detail" }, { snapshot: { ...s, desktopUpdates: [status] } });
  }
  for (const [id, taskState] of s.tasks.map(t => [t.id, t.state] as const)) {
    add(`workspace-selected-${taskState}-${id}`, { screen: "sessions", selected: { sessions: `session:${id}` }, focus: "detail" });
  }
  for (const activity of ["working", "waiting", "idle", "needs_input"] as const) {
    const conversation = structuredClone(s);
    const task = conversation.tasks[0]!;
    Object.assign(task, { interactionMode: "conversation", state: activity === "needs_input" ? "needs_input" : "running", conversation: { activity }, question: { text: "Which output format?" }, session: { host: "local", id: "fixture" } });
    add(`conversation-${activity}`, { screen: "sessions", selected: { sessions: `session:${task.id}` }, focus: "detail" }, { snapshot: conversation });
  }
  for (const selected of ["account:spare", "account-add", "account-link"]) add(`settings-select-${selected}`, { screen: "settings", section: "accounts", focus: "detail", selected: { settings: selected } });
  for (const state of ["loading", "error", "empty"] as const) {
    const d = { ...detail, messages: state === "loading" ? { loading: true } : state === "error" ? { error: { code: "unavailable", message: "Unavailable" } } : { value: [] } };
    add(`thread-${state}`, { screen: "sessions", selected: { sessions: "session:t-0412" }, focus: "detail", scroll: 15 }, { details: { "t-0412": { value: d } } });
  }
  const workDetail = { ...detail, work: { rootId: "t-0412", parentId: null, depth: 0, userStarted: true, allowDelegation: true },
    workTree: { totals: { tasks: 2, running: 1, queued: 0, executionSeconds: 125.5, dependencyWaitSeconds: null, childWaitSeconds: 5.5, capacityWaitSeconds: 0,
      usagePools: [{ account: "team", observedDeltaPct: 1.25, unknownAttempts: 1 }] },
      nodes: [{ taskId: "t-0412", title: "Root task", depth: 0, state: "done", model: "model", actualModel: null, dependencies: [], decisions: [], attempts: [] },
        { taskId: "child", title: "Write regression tests", depth: 1, state: "failed", dependencies: ["dependency"], retryEligibility: { allowed: true, reason: "Ready to retry" }, decisions: [{ attempt: 1, engine: { id: "fixture" }, proposal: { choices: [{ id: "c1", reason: "Available" }] }, selectedCandidateId: "c1", fallback: { reason: "unavailable" } }], attempts: [{ model: "requested", actualModel: "observed" }] }] },
  } as unknown as TaskDetail;
  add("workspace-work-tree", { screen: "sessions", selected: { sessions: "session:t-0412" }, focus: "detail", scroll: 14 }, { details: { "t-0412": { value: workDetail } } });
  add("upgrade-controls", { screen: "settings", section: "updates", focus: "detail" }, { settings: { ...data.settings, update: { value: { current: "0.3.1\x1b[31m", latest: null, available: false } } } });
  const overlayCases = [
    { kind: "help", scroll: 0 },
    { kind: "help", scroll: 12 },
    { kind: "confirm", title: "Stop this task?", body: ["The executor will stop. Your changes stay in the worktree."], yes: "Stop", alt: { key: "w", label: "Wait" } },
    { kind: "menu", title: "Task actions", index: 1, actions: [{ label: "Reply" }, { label: "Stop", danger: true }] },
    { kind: "prompt", spec: { title: "Reply", label: "Your message", help: "Sent to this thread" }, value: "Check 界界 e\u0301 😀", error: "Message is required" },
  ];
  overlayCases.forEach((overlay, i) => add(`overlay-${i}`, { screen: "sessions", overlay } as unknown as Partial<UiState>));
  // Every selectable row gets its own viewport, including rows below the fold.
  for (const [name, state] of [...cases, ["setup", { screen: "setup" }] as const]) {
    const current = name === "setup" ? setup : s;
    for (const item of screenItems(current, current.at, { state, data })) {
      add(`select-${name}-${item.id}`, {
        ...state, selected: { [state.screen!]: item.id }, focus: "detail",
      }, name === "setup" ? { snapshot: current } : {});
    }
  }
  for (const section of SECTIONS) {
    add(`settings-${section.id}-unsupported`, { screen: "settings", section: section.id, focus: "detail" }, { ops: [] });
    add(`settings-${section.id}-empty`, { screen: "settings", section: section.id, focus: "detail" }, {
      snapshot: empty,
      settings: { ...data.settings, accounts: { value: [] }, routing: { value: { rules: [], available: [] } }, projects: { value: [] }, strategies: { value: [] } },
    });
  }
  for (const state of ["loading", "error", "removed", "refreshing"] as const) {
    const resource = state === "refreshing" ? { loading: true, value: detail }
      : state === "loading" ? { loading: true }
      : { error: { code: "unavailable", message: state === "removed" ? "Worktree not found" : "Could not read task", hint: "Refresh to retry" } };
    add(`review-detail-${state}`, { screen: "review", selected: { review: "review:t-0412" }, focus: "detail" }, { details: { "t-0412": resource } });
    const active = s.tasks.find(t => t.state === "running")!;
    add(`workspace-detail-${state}`, { screen: "sessions", selected: { sessions: `session:${active.id}` }, focus: "detail", scroll: 10 }, { details: { [active.id]: resource } });
  }
  const older = { ...s.tasks[0]!, id: "older", title: "Earlier task", fullTitle: "Earlier task", state: "stopped", updatedAt: s.at - 86400 } as ClientSnapshot["tasks"][number];
  for (const history of [{ error: { code: "unavailable", message: "History unavailable", hint: "Refresh to retry" } }, { loading: true }, { value: { tasks: [older, { ...s.tasks[0]!, fullTitle: "Stale history must lose to snapshot" }], next: "cursor" } }]) {
    const name = "error" in history ? "error" : "value" in history ? "page" : "loading";
    add(`workspace-history-${name}`, { screen: "sessions", selected: { sessions: "history-more" } }, { history } as Partial<FrameCase>);
  }
  for (const reason of ["interactive", "unsupported", "unverified", "refused", "unavailable"] as const) {
    add(`review-managed-skip-${reason}`, { screen: "review", selected: { review: "review:t-0412" }, focus: "detail", scroll: 5 }, {
      details: { "t-0412": { value: { ...detail, managedSkip: { reason } } as unknown as TaskDetail } },
    });
  }
  for (const active of [false, true]) {
    const task = { ...s.tasks[0]!, interactionMode: "conversation", state: "needs_input", rev: 4, question: { text: "Which output format?" }, session: active ? { host: "local", id: "fixture" } : undefined } as ClientSnapshot["tasks"][number];
    const managed = { ...detail, id: task.id, rev: 4, state: "needs_input", question: task.question,
      work: { rootId: task.id, parentId: null, userStarted: true, allowDelegation: true },
      workTree: { ...workDetail.workTree!, nodes: [{ ...workDetail.workTree!.nodes[1]!, taskId: task.id }] },
    } as unknown as TaskDetail;
    add(`workspace-managed-question-${active}`, { screen: "sessions", selected: { sessions: `session:${task.id}` }, focus: "detail" }, {
      snapshot: { ...s, tasks: [task] }, details: { [task.id]: { value: managed } }, ops: ["dispatch.answer", "dispatch.retry", "session.end", "task.attach", "msg.log"],
    });
  }
  const senders = ["human", "broker", "external:planner", "task:t-0412", "task:missing", "unknown"];
  const messages = Array.from({ length: 26 }, (_, i) => ({
    ...detail.messages!.value![0]!, id: `m${i.toString().padStart(2, "0")}`, from: senders[Math.floor(i / 3) % senders.length]!,
    kind: (["message", "question", "answer", "report", "nudge", "close"] as const)[i % 6]!, body: `Message ${i} with 界界 and e\u0301.`,
    createdAt: s.at - 2400 + Math.floor(i / 2) * 120, status: i % 3 === 0 ? "held" : i % 3 === 1 ? "read" : "delivered",
  }));
  for (const scroll of [14, 32, 60]) add(`thread-grouped-${scroll}`, { screen: "sessions", selected: { sessions: "session:t-0412" }, focus: "detail", scroll }, {
    details: { "t-0412": { value: { ...detail, messages: { value: [...messages].reverse() } } as unknown as TaskDetail } },
  });
  const liveTask = s.tasks.find(t => t.state === "running")!;
  const timeline = ["queued", "running", "Testing", "testing", "done", "partial", "failed", "limit", "stopped", "needs_input", "hook: PostToolUse", "hook: PreToolUse", "hook: Stop", "hook: SessionStart", "hook: SessionEnd", "1 commit", "2 commits", "Worktree created from main", "Routed to codex", "unknown"]
    .flatMap((text, i) => [{ at: s.at - 600 + i * 10, text }, { at: s.at - 600 + i * 10, text }]);
  for (const scroll of [8, 20]) add(`workspace-timeline-${scroll}`, { screen: "sessions", selected: { sessions: `session:${liveTask.id}` }, focus: "detail", scroll }, {
    details: { [liveTask.id]: { value: { ...detail, id: liveTask.id, state: "running", timeline } } },
  });
  for (const reading of ["unchecked", "current", "attached", "no-progress", "coordination_failed", "notification_failed"] as const) {
    const status: UpdateStatus = { installationId: "fixture", revision: 1, phase: reading === "no-progress" ? "downloading" : "idle", transactionId: null, autoDownload: false,
      checkedAt: reading === "unchecked" ? null : s.at, blockers: [], downloadedBytes: 0, totalBytes: null, current: "0.3.1", target: null, releaseNotes: null,
      ownership: reading === "attached" ? "attached" : "managed", error: reading.endsWith("failed") ? { code: reading, message: "Waiting for updated status", hint: "Refresh to retry" } : null,
      actions: reading === "attached" ? [] : ["check", "configure"],
    };
    add(`desktop-upgrade-${reading}`, { screen: "settings", section: "updates", focus: "detail" }, { snapshot: { ...s, desktopUpdates: [status] } });
  }
  add("setup-complete", { screen: "setup" });
  for (const [i, cost] of [
    { account: "codex#team", deltaPct: null, window: null, reason: "shared" },
    { account: "codex", deltaPct: null, window: null },
    { account: "codex", deltaPct: 0, window: "weekly" },
    { account: "codex", deltaPct: 2.5, window: "5h" },
  ].entries()) add(`review-cost-${i}`, { screen: "review", selected: { review: "review:t-0412" }, focus: "detail", scroll: 14 }, {
    details: { "t-0412": { value: { ...detail, cost: { executor: cost }, routing: { why: "behind, used 12.5% / pace 25.5%; codex busy", skipped: [{ executor: "cursor", reason: "Blocked by you" }] } } } },
  });
  for (const eligibility of ["eligible", "ineligible", "uncertain"] as const) {
    const evidence = structuredClone(s);
    Object.assign(evidence.executors![1]!, { state: "failing", untested: true, recentFailures: 2, lastCheck: { passed: true, at: s.at }, reason: "Recent runs failed",
      eligibility: { state: eligibility, budget: eligibility === "eligible" ? "exhausted" : "unknown", reasons: [{ code: "subscription_missing" }, { code: "unknown" }], evidenceAgeS: 120, evaluatedAt: s.at - 60 } });
    Object.assign(evidence.executors![2]!, { limitedBy: "host", host: evidence.hosts![0]!.alias });
    add(`settings-eligibility-${eligibility}`, { screen: "settings", section: "executors", focus: "detail", selected: { settings: `executor:${evidence.executors![1]!.id}` } }, { snapshot: evidence });
  }
  const historical = structuredClone(s);
  Object.assign(historical.accounts![0]!, { stale: false, capturedAt: s.at - 100000, eligibility: { budget: "unknown" } });
  add("settings-accounts-historical", { screen: "settings", section: "accounts", focus: "detail" }, { snapshot: historical });
  for (const unlimited of [false, true]) {
    const machine = { ...s.machine!, unlimited, hardCap: unlimited ? null : 4, memoryPressure: null, loadPerCore: 2.675, open: false, detail: "memory pressure is high" };
    const config = structuredClone(data.settings);
    Object.assign(config.config!.value!.keys, {
      "execution.local_max_tasks": { value: "unlimited", source: "default" },
      "execution.local_memory_pressure_limit": { value: "warning", source: "default" },
      "execution.local_load_limit": { value: 2.5, source: "default" },
      "execution.backend": { value: "orca", source: "env:PACER_BACKEND" },
    });
    add(`settings-machine-guard-${unlimited}`, { screen: "settings", section: "machine", focus: "detail" }, { snapshot: { ...s, machine }, settings: config });
    add(`settings-capacity-${unlimited}`, { screen: "settings", section: "executors", focus: "detail", selected: { settings: "executor:cursor" } }, { snapshot: { ...s, machine } });
  }
  for (const screen of ["home", "review", "sessions"] as const) {
    add(`invalid-selection-${screen}`, { screen, selected: { [screen]: "missing" }, focus: "detail" });
    add(`no-selection-${screen}`, { screen, selected: { [screen]: "" }, focus: "detail" });
    add(`restricted-help-${screen}`, { screen, overlay: { kind: "help", scroll: 0 } }, { ops: [] });
  }
  add("restricted-settings", { screen: "settings", section: "planner", focus: "detail" }, { ops: [] });
  add("restricted-thread", { screen: "sessions", selected: { sessions: "session:t-0412" }, focus: "detail" }, { ops: [] });
  const unicode = structuredClone(s);
  unicode.planner!.advice = "\ufeff界界 e\u0301 😀\u0301 \x1b[31m untrusted \u0085 input";
  unicode.tasks[0]!.fullTitle = "\ufeff  界界 e\u0301 😀 a long title with combining marks  \ufeff";
  add("unicode-controls", { screen: "home" }, { snapshot: unicode });
  for (const value of ["\ufeff 12.5\u00a0", "0b101", "bad number", true, 1e21]) {
    const config = structuredClone(data.settings);
    config.config!.value!.keys["pacing.planner_reserve"]!.value = value;
    add(`planner-number-${String(value).replace(/[^a-z0-9]/gi, "_")}`, { screen: "settings", section: "planner", focus: "detail" }, { settings: config });
  }
  for (const phase of ["available", "waiting", "reserved", "installing", "verifying", "committed", "restored", "recovery-failed", "cancelled"] as const) {
    const status: UpdateStatus = { installationId: "fixture", revision: 1, phase: "idle", transactionId: null, autoDownload: false,
      checkedAt: null, blockers: [], downloadedBytes: 0, totalBytes: null, current: "0.3.1", target: null, releaseNotes: null, ownership: "attached", error: null,
      actions: phase === "available" || phase === "cancelled" ? ["adopt", "configure"] : phase === "waiting" ? ["adoptCancel"] : [],
      adoption: { phase, revision: 2, previousInstallationId: "previous", resultingInstallationId: null, currentServiceExecutable: "/tmp/fixture/old/bin/pacer", replacementServiceExecutable: "/tmp/fixture/Desktop.app/Contents/MacOS/pacer", serviceLabel: "pacer-fixture", port: 4883, blockers: [{ kind: "session", id: "s1", label: "A session is running" }], error: null },
    };
    add(`desktop-adoption-${phase}`, { screen: "settings", section: "updates", focus: "detail" }, { snapshot: { ...s, desktopUpdates: [status] } });
    if (phase === "available") add("desktop-adoption-unicode-path", { screen: "settings", section: "updates", focus: "detail" }, {
      snapshot: { ...s, desktopUpdates: [{ ...status, adoption: { ...status.adoption!, currentServiceExecutable: "/" + "a".repeat(71) + "😀/tail" } }] },
    });
  }
  for (const [width, height] of [[1, 1], [40, 10], [59, 16], [60, 15], [200, 16]]) generated.push({ name: `boundary-${width}x${height}`, width: width!, height: height!, state: { screen: "home" } });
  for (const [name, state] of cases) for (const width of [109, 110]) generated.push({ name: `boundary-${name}-${width}x16`, width, height: 16, state });
  return { snapshot: s, details: Object.fromEntries(data.details), settings: data.settings,
    cases: generated,
  };
}

export function frames(): Record<string, string> {
  const c = corpus();
  return Object.fromEntries(c.cases.map(entry => [entry.name, renderCase(c, entry)]));
}

export function renderCase(c: ReturnType<typeof corpus>, { name, width, height, state, snapshot, settings, details, history, ...options }: FrameCase): string {
  const s = snapshot ?? c.snapshot;
  const rendered = renderDashboard(s, width, height, s.at, { theme: PLAIN_THEME,
    data: { details: new Map(Object.entries(details ?? c.details)), settings: settings ?? c.settings, history }, state,
    version: "0.0.0-test", timeZone: "UTC", ...options });
  // Match bytes written to a terminal; JS slices may leave isolated surrogates.
  return Buffer.from(rendered, "utf8").toString("utf8");
}
