import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import type { BrowserApi } from "../app/src/data/api";
import { SetupHealthStage } from "../app/src/screens/setup/SetupHealth";
import {
  SetupHealthGate,
  applyRepair,
  applySetupSkip,
  commitSetupHealthLoad,
  gateRemedyHost,
  loadSetupHealthGate,
  setupHealthFailureReport,
} from "../app/src/screens/setup/SetupHealthGate";
import { remedies } from "../src/install/doctor-remedy";
import type { SetupHealthReport, SetupHealthRepair } from "../src/view-model/setup-health";
import { clickText, countForms, domText, installDom, isDisabled, mount, submitForm, tick, until, unmount } from "./app-setup-health-dom";

const okReport = (): SetupHealthReport & { skipFullWindow?: boolean } => ({
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
  skipFullWindow: false,
});

test("setup.health rejection maps to a hard_fail gate that stays until Continue", () => {
  const report = setupHealthFailureReport("startup");
  expect(report.outcome).toBe("hard_fail");
  expect(report.steps.find(s => s.id === "service")?.state).toBe("failed");
  expect(report.steps.find(s => s.id === "service")?.detail).toContain("could not finish");
  expect(report.steps.find(s => s.id !== "service")?.state).toBe("not_checked");
  expect(report.repairs).toEqual([]);
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} />,
  );
  expect(html).toContain("Continue anyway");
  expect(html).toContain("Open Diagnostics");
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("Continue to pacer");
});

test("loadSetupHealthGate never silently skips when setup.health rejects", async () => {
  const call = (async () => {
    throw new Error("unavailable");
  }) as BrowserApi["call"];
  const result = await loadSetupHealthGate(call);
  expect(result.kind).toBe("fail");
  if (result.kind !== "fail") return;
  expect(result.report.outcome).toBe("hard_fail");
  expect(result.report.steps.find(s => s.id === "service")?.detail).toContain("could not finish");
});

test("loadSetupHealthGate skips only when the op says skipFullWindow", async () => {
  const call = (async () => ({ ...okReport(), skipFullWindow: true })) as BrowserApi["call"];
  const result = await loadSetupHealthGate(call);
  expect(result.kind).toBe("skip");
  if (result.kind !== "skip") return;
  expect(result.summary.outcome).toBe("ok");
});

test("loadSetupHealthGate keeps hard_fail on stage without auto-enter", async () => {
  const call = (async () => ({
    ...okReport(),
    outcome: "hard_fail" as const,
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "service" ? { ...s, state: "failed" as const } : s),
  })) as BrowserApi["call"];
  const result = await loadSetupHealthGate(call);
  expect(result.kind).toBe("stage");
  if (result.kind !== "stage") return;
  expect(result.report.outcome).toBe("hard_fail");
  expect(result.autoEnterMs).toBeUndefined();
});

test("SetupHealthGate commit path: rejecting setup.health stays on stage (no silent ready)", async () => {
  const call = (async () => {
    throw new Error("unavailable");
  }) as BrowserApi["call"];
  const load = await loadSetupHealthGate(call);
  const commit = commitSetupHealthLoad(load);
  expect(commit.action).toBe("stage");
  if (commit.action !== "stage") return;
  expect(commit.report.outcome).toBe("hard_fail");
  expect(commit.autoEnterMs).toBeUndefined();
  expect(commit.report.steps.find(s => s.id === "service")?.detail).toContain("could not finish");
});

test("SetupHealthGate commit path: hard_fail report stays on stage without auto-enter", async () => {
  const call = (async () => ({
    ...okReport(),
    outcome: "hard_fail" as const,
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "service" ? { ...s, state: "failed" as const } : s),
  })) as BrowserApi["call"];
  const commit = commitSetupHealthLoad(await loadSetupHealthGate(call));
  expect(commit.action).toBe("stage");
  if (commit.action !== "stage") return;
  expect(commit.autoEnterMs).toBeUndefined();
});

test("SetupHealthGate commit path: warnings report stays on stage without auto-enter", async () => {
  const call = (async () => ({
    ...okReport(),
    outcome: "warnings" as const,
    attentionCount: 1,
    steps: okReport().steps.map(s => s.id === "integrations" ? { ...s, state: "needs_attention" as const } : s),
  })) as BrowserApi["call"];
  const commit = commitSetupHealthLoad(await loadSetupHealthGate(call));
  expect(commit.action).toBe("stage");
  if (commit.action !== "stage") return;
  expect(commit.report.outcome).toBe("warnings");
  expect(commit.autoEnterMs).toBeUndefined();
});

test("SetupHealthGate commit path: skipFullWindow is the only silent ready entry", async () => {
  const skip = commitSetupHealthLoad(await loadSetupHealthGate(
    (async () => ({ ...okReport(), skipFullWindow: true })) as BrowserApi["call"],
  ));
  expect(skip.action).toBe("ready");
  const ok = commitSetupHealthLoad(await loadSetupHealthGate(
    (async () => okReport()) as BrowserApi["call"],
  ));
  expect(ok.action).toBe("stage");
  if (ok.action !== "stage") return;
  expect(ok.autoEnterMs).toBe(600);
});

function gateHarness(answer = true) {
  const calls: [string, unknown][] = [], asked: [string, string | undefined, string | undefined][] = [], opened: string[] = [];
  const api = { call: async (op: string, params: unknown) => {
    calls.push([op, params]);
    if (op === "agent.preview") return { revision: "rev-3", agent: (params as { agent: string }).agent, files: ["$HOME/.cursor/hooks.json"] };
    if (op === "doctor.fix.delegate") return { task: { task_id: "t 7" } };
    return {};
  } } as unknown as Pick<BrowserApi, "call">;
  const host = gateRemedyHost(api, async (message, title, label) => { asked.push([message, title, label]); return answer; }, url => { opened.push(url); });
  return { host, calls, asked, opened };
}
const repair = (check: string, remedy: SetupHealthRepair["remedy"]): SetupHealthRepair => ({ kind: "remedy", label: remedy!.label, check, remedy });

async function withLocation<T>(run: (location: { hash: string }) => Promise<T>): Promise<T> {
  const previous = (globalThis as { location?: unknown }).location;
  const location = { hash: "#/" };
  (globalThis as { location?: unknown }).location = location;
  try { return await run(location); } finally { (globalThis as { location?: unknown }).location = previous; }
}

test("gate repairs use the shared remedy dispatch: automatic remedies rerun, consent only after confirm", async () => {
  const plain = gateHarness();
  expect(await applyRepair(repair("Usage codex", remedies.refreshUsage("codex")), plain.host)).toBe("rerun");
  expect(plain.calls).toEqual([["limits.refresh", { account: "codex" }]]);
  expect(plain.asked).toEqual([]);
  const files = gateHarness();
  expect(await applyRepair(repair("Integration freshness cursor", remedies.updateFiles("cursor")), files.host)).toBe("rerun");
  expect(files.asked[0]![0]).toContain("$HOME/.cursor/hooks.json");
  expect(files.calls).toEqual([["agent.preview", { agent: "cursor" }], ["agent.connect", { agent: "cursor", preview_revision: "rev-3", consent: true }]]);
  const declined = gateHarness(false);
  expect(await applyRepair(repair("Service", remedies.service("Restart service")), declined.host)).toBe("done");
  expect(declined.asked[0]![0]).toContain("restarts its background service");
  expect(declined.calls).toEqual([]);
});

test("gate review repairs show the files and apply that preview's revision", async () => {
  const gate = gateHarness();
  expect(await applyRepair(repair("Install cursor", remedies.review("cursor")), gate.host)).toBe("rerun");
  expect(gate.asked[0]![0]).toContain("$HOME/.cursor/hooks.json");
  expect(gate.calls).toEqual([["agent.preview", { agent: "cursor" }], ["agent.connect", { agent: "cursor", consent: true, preview_revision: "rev-3" }]]);
});

test("gate user remedies sign in or open an allowed link and rerun when the person returns", async () => {
  const gate = gateHarness();
  expect(await applyRepair(repair("Usage codex", remedies.signIn("codex", "Codex")), gate.host)).toBe("rerun-on-return");
  expect(await applyRepair(repair("Removable volume access", remedies.privacySettings()), gate.host)).toBe("rerun-on-return");
  expect(gate.calls).toEqual([["account.signin", { name: "codex" }]]);
  expect(gate.opened).toHaveLength(1);
  expect(gate.opened[0]).toStartWith("x-apple.systempreferences:");
});

test("skipping an optional setup step persists via setup.skip and reruns the checks", async () => {
  const api = { call: async (op: string, params: unknown) => {
    expect(op).toBe("setup.skip");
    expect(params).toEqual({ step: "notifications" });
    return { skipped: true };
  } } as Pick<BrowserApi, "call">;
  const calls: string[] = [];
  const spy = { call: async (op: string, params: unknown) => { calls.push(op); return (api as any).call(op, params); } } as Pick<BrowserApi, "call">;
  expect(await applySetupSkip(spy)).toBe("rerun");
  expect(calls).toEqual(["setup.skip"]);
});

test("gate agent remedies start a fix task after confirm and open it; no remedy opens Diagnostics", async () => {
  await withLocation(async location => {
    const gate = gateHarness();
    expect(await applyRepair(repair("Binary cursor", remedies.agent("Binary cursor")), gate.host)).toBe("navigate");
    expect(gate.calls).toEqual([["doctor.fix.delegate", { check: "Binary cursor", scope: "fix" }]]);
    expect(location.hash).toBe("#/tasks/t%207");
    const declined = gateHarness(false);
    expect(await applyRepair(repair("Binary cursor", remedies.agent("Binary cursor")), declined.host)).toBe("done");
    expect(declined.calls).toEqual([]);
    expect(await applyRepair({ kind: "open.diagnostics", label: "Open Diagnostics" }, gateHarness().host)).toBe("navigate");
    expect(location.hash).toBe("#/settings/diagnostics");
  });
});

test("the gate's repair host waits for the restarted service before its rerun", async () => {
  const { gateRemedyHost } = await import("../app/src/screens/setup/SetupHealthGate");
  const pids = [10, 11];
  const api = { call: async <T,>(op: string) => { expect(op).toBe("snapshot.get"); return { snapshot: { service: { pid: pids.shift() ?? 11 } } } as T; } };
  const host = gateRemedyHost(api as never, async () => true, () => {});
  await host.awaitRestart!(10);
  expect(pids).toEqual([]);
});

test("the gate's restart wait keeps one snapshot.get in flight: its call is one stable function per host", async () => {
  let calls = 0, releaseRead!: (value: unknown) => void;
  const api = {
    call: async <T,>(op: string) => {
      if (op !== "snapshot.get") return {} as T;
      if (++calls === 1) return new Promise<T>(resolve => { releaseRead = value => resolve(value as T); });
      return { snapshot: { service: { pid: 11 } } } as T;
    },
  } as unknown as Pick<BrowserApi, "call">;
  const host = gateRemedyHost(api, async () => true);
  const wait = host.awaitRestart!(10);
  // The first poll's read holds past servicePid's own timeout; the next poll must reuse that
  // pending read (same call identity) instead of starting a second request.
  await new Promise<void>(resolve => setTimeout(resolve, 4500));
  expect(calls).toBe(1);
  releaseRead({ snapshot: { service: { pid: 11 } } });
  await wait;
  expect(calls).toBe(1);
}, 20000);

// ---------------------------------------------------------------------------
// DOM render + click tests (review 2, item 5): the gate's repair surface must
// actually react to clicks, not just string-render. Follows the fake-DOM
// preact pattern from app-dispatcher-model-choice.test.tsx.
// ---------------------------------------------------------------------------

function autoRunReport(repairs: SetupHealthRepair[]): SetupHealthReport {
  return {
    trigger: "startup",
    title: "Checking setup",
    support: "Making sure agents can work through pacer.",
    steps: [
      { id: "service", title: "Service ready", state: "passed" },
      { id: "detect_agents", title: "Detect agents", state: "needs_attention" },
      { id: "integrations", title: "Integrations & hooks", state: "needs_attention" },
      { id: "usage_eligibility", title: "Usage & eligibility", state: "passed" },
      { id: "ready", title: "Ready to take work", state: "passed" },
    ],
    outcome: "warnings",
    attentionCount: repairs.length,
    checkedAt: 100,
    repairs,
  };
}

const twoAutoFixes: SetupHealthRepair[] = [
  { kind: "remedy", label: "Refresh usage", check: "Refresh usage", remedy: remedies.refreshUsage("codex") },
  { kind: "remedy", label: "Reinstall service", check: "Reinstall service", remedy: remedies.service("Reinstall service") },
];

test("SetupHealthGate DOM: a rejecting setup.health reruns checks on Run checks again", async () => {
  const dom = installDom();
  try {
    const calls: string[] = [];
    let settleSecond!: (report: SetupHealthReport) => void;
    const call = (async (op: string) => {
      calls.push(op);
      if (op !== "setup.health") return {};
      if (calls.filter(o => o === "setup.health").length === 1) throw new Error("boom");
      return new Promise<SetupHealthReport>(resolve => { settleSecond = resolve; });
    }) as BrowserApi["call"];
    await mount(dom, <SetupHealthGate api={{ call } as unknown as BrowserApi} connected enabled onReady={() => {}} />);
    await until(() => domText(dom.container).includes("Run checks again"));
    expect(domText(dom.container)).toContain("pacer can take work reliably");
    expect(domText(dom.container)).toContain("boom");

    clickText(dom.container, "Run checks again");
    await until(() => calls.filter(o => o === "setup.health").length === 2);
    await tick();
    expect(domText(dom.container)).toContain("Checking setup");
    expect(calls.filter(o => o === "setup.health")).toHaveLength(2);

    settleSecond(autoRunReport([]));
    await until(() => domText(dom.container).includes("Run checks again"));
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("SetupHealthGate Fix all: one confirm, service.install committed last, setup.health reruns after", async () => {
  const dom = installDom();
  try {
    let pid = 100;
    const calls: string[] = [];
    const committed: string[] = [];
    const report = autoRunReport(twoAutoFixes);
    const call = (async (op: string) => {
      calls.push(op);
      switch (op) {
        case "setup.health": {
          // First load offers the two fixes; the post-fix rerun comes back clean.
          return calls.filter(o => o === "setup.health").length === 1 ? { ...report } : autoRunReport([]);
        }
        case "snapshot.get": return { snapshot: { service: { pid } } };
        case "limits.refresh": committed.push("limits.refresh"); return {};
        case "service.install": committed.push("service.install"); pid += 1; return { restarting: true };
        default: return {};
      }
    }) as BrowserApi["call"];
    await mount(dom, <SetupHealthGate api={{ call } as unknown as BrowserApi} connected enabled onReady={() => {}} />);
    await until(() => domText(dom.container).includes("Fix 2 issues automatically"));

    clickText(dom.container, "Fix 2 issues automatically");
    await until(() => countForms(dom.container) === 1);
    expect(countForms(dom.container)).toBe(1); // dialogs.confirm is opened exactly once for the batch
    submitForm(dom.container);

    await until(() => committed.length === 2 && calls.filter(o => o === "setup.health").length === 2);
    expect(committed).toEqual(["limits.refresh", "service.install"]);
    expect(calls.filter(o => o === "service.install")).toHaveLength(1);
    expect(calls.filter(o => o === "setup.health")).toHaveLength(2);
    await tick();
    expect(countForms(dom.container)).toBe(0);
    await until(() => domText(dom.container).includes("Run checks again"));
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("SetupHealthGate Fix all: a rejecting commit names the fix and still commits the other", async () => {
  const dom = installDom();
  try {
    let pid = 5;
    const calls: string[] = [];
    const committed: string[] = [];
    const report = autoRunReport(twoAutoFixes);
    let settleSecond!: (report: SetupHealthReport) => void;
    const call = (async (op: string) => {
      calls.push(op);
      switch (op) {
        case "setup.health": {
          if (calls.filter(o => o === "setup.health").length === 1) return { ...report };
          return new Promise<SetupHealthReport>(resolve => { settleSecond = resolve; });
        }
        case "snapshot.get": return { snapshot: { service: { pid } } };
        case "limits.refresh": committed.push("limits.refresh"); return {};
        case "service.install": throw new Error("could not restart the service");
        default: return {};
      }
    }) as BrowserApi["call"];
    await mount(dom, <SetupHealthGate api={{ call } as unknown as BrowserApi} connected enabled onReady={() => {}} />);
    await until(() => domText(dom.container).includes("Fix 2 issues automatically"));

    clickText(dom.container, "Fix 2 issues automatically");
    await until(() => countForms(dom.container) === 1);
    submitForm(dom.container);

    await until(() => calls.includes("service.install") && calls.filter(o => o === "setup.health").length === 2);
    expect(committed).toEqual(["limits.refresh"]);
    expect(calls.filter(o => o === "service.install")).toHaveLength(1);
    settleSecond(setupHealthFailureReport("startup", new Error("boom2")));
    await until(() => domText(dom.container).includes("The fix did not finish"));
    expect(domText(dom.container)).toContain("Reinstall service");
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("SetupHealthGate Restart service: a rejecting op shows The fix did not finish and re-enables buttons", async () => {
  const dom = installDom();
  try {
    const calls: string[] = [];
    const call = (async (op: string) => {
      calls.push(op);
      if (op === "setup.health") return setupHealthFailureReport("startup", new Error("boom"));
      if (op === "snapshot.get") return { snapshot: { service: { pid: 7 } } };
      if (op === "service.install") throw new Error("pacer service is busy");
      return {};
    }) as BrowserApi["call"];
    await mount(dom, <SetupHealthGate api={{ call } as unknown as BrowserApi} connected enabled onReady={() => {}} />);
    await until(() => domText(dom.container).includes("Restart service"));
    expect(isDisabled(dom.container, "Restart service")).toBe(false);
    expect(isDisabled(dom.container, "Run checks again")).toBe(false);

    clickText(dom.container, "Restart service");
    await until(() => countForms(dom.container) === 1);
    submitForm(dom.container); // accept the restart consent, then commit rejects
    await until(() => domText(dom.container).includes("The fix did not finish"));
    expect(domText(dom.container)).toContain("pacer service is busy");
    expect(calls.filter(o => o === "service.install")).toHaveLength(1);
    expect(isDisabled(dom.container, "Restart service")).toBe(false);
    expect(isDisabled(dom.container, "Run checks again")).toBe(false);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("SetupHealthGate Restart service: asks for consent; declining sends no service.install and keeps buttons enabled", async () => {
  const dom = installDom();
  try {
    const calls: string[] = [];
    const call = (async (op: string) => {
      calls.push(op);
      if (op === "setup.health") return setupHealthFailureReport("startup", new Error("boom"));
      if (op === "snapshot.get") return { snapshot: { service: { pid: 7 } } };
      if (op === "service.install") return { restarting: true };
      return {};
    }) as BrowserApi["call"];
    await mount(dom, <SetupHealthGate api={{ call } as unknown as BrowserApi} connected enabled onReady={() => {}} />);
    await until(() => domText(dom.container).includes("Restart service"));

    clickText(dom.container, "Restart service");
    await until(() => countForms(dom.container) === 1);
    expect(countForms(dom.container)).toBe(1); // exactly one confirmation

    clickText(dom.container, "Cancel"); // decline the restart consent
    await until(() => countForms(dom.container) === 0);
    expect(calls.filter(o => o === "snapshot.get")).toHaveLength(0);
    expect(calls.filter(o => o === "service.install")).toHaveLength(0);
    expect(calls.filter(o => o === "setup.health")).toHaveLength(1); // no rerun
    expect(isDisabled(dom.container, "Restart service")).toBe(false);
    expect(isDisabled(dom.container, "Run checks again")).toBe(false);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("SetupHealthGate Restart service: accepting consent sends service.install once and reruns setup.health", async () => {
  const dom = installDom();
  try {
    let pid = 7;
    const calls: string[] = [];
    const call = (async (op: string) => {
      calls.push(op);
      if (op === "setup.health") return setupHealthFailureReport("startup", new Error("boom"));
      if (op === "snapshot.get") return { snapshot: { service: { pid } } };
      if (op === "service.install") { pid += 1; return { restarting: true }; }
      return {};
    }) as BrowserApi["call"];
    await mount(dom, <SetupHealthGate api={{ call } as unknown as BrowserApi} connected enabled onReady={() => {}} />);
    await until(() => domText(dom.container).includes("Restart service"));

    clickText(dom.container, "Restart service");
    await until(() => countForms(dom.container) === 1);
    submitForm(dom.container); // accept the restart consent

    await until(() => calls.filter(o => o === "service.install").length === 1 && calls.filter(o => o === "setup.health").length === 2);
    expect(calls.filter(o => o === "service.install")).toHaveLength(1);
    expect(calls.filter(o => o === "setup.health")).toHaveLength(2);
    await tick();
    expect(countForms(dom.container)).toBe(0);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});

test("SetupHealthGate Fix all: declining the confirmation keeps 'No changes were made.' visible and commits nothing", async () => {
  const dom = installDom();
  try {
    const calls: string[] = [];
    const report = autoRunReport(twoAutoFixes);
    const call = (async (op: string) => {
      calls.push(op);
      if (op === "setup.health") return { ...report };
      return {};
    }) as BrowserApi["call"];
    await mount(dom, <SetupHealthGate api={{ call } as unknown as BrowserApi} connected enabled onReady={() => {}} />);
    await until(() => domText(dom.container).includes("Fix 2 issues automatically"));

    clickText(dom.container, "Fix 2 issues automatically");
    await until(() => countForms(dom.container) === 1);
    clickText(dom.container, "Cancel"); // decline the batch consent
    await until(() => countForms(dom.container) === 0);
    expect(domText(dom.container)).toContain("No changes were made.");
    expect(calls.filter(o => o === "limits.refresh")).toHaveLength(0);
    expect(calls.filter(o => o === "service.install")).toHaveLength(0);
  } finally {
    await unmount(dom);
    dom.restore();
  }
});
