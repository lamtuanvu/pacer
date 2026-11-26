/** Settings › Dispatcher › Overview renders Native subagent control and keeps certification user-initiated. */
import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { act } from "preact/test-utils";
import type { BrowserApi } from "../app/src/data/api";
import { initialState } from "../app/src/data/store";
import { DispatcherEnforcementRows, DispatcherSection } from "../app/src/screens/settings/Dispatcher";
import { TaskContext } from "../app/src/screens/task-shared";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { clickText, domText, installDom, mount, tick, until, unmount, type TestDom } from "./app-setup-health-dom";

const view = { strategy: "custom", planner: "claude-code", plannerAccount: "team", source: "strategy", config: dispatchConfigSchema.parse({}) };
const runner = {
  runner: "claude-code", account: "team", agent: "claude-code", version: "2.1.281",
  probeSupported: true, unsupportedReason: null, probeMode: "ask" as const, state: "uncertified" as const,
  reason: "Native subagent control has not been verified", lastProbedAt: null, expiresAt: null,
  nextEligibleAt: 0, probesToday: 0, lastCostPct: null, consent: "unasked" as const,
};
const OPS = ["dispatch.config.get", "dispatch.models", "dispatch.enforcement", "dispatch.enforcement.probe", "dispatch.enforcement.consent"];
type Call = { op: string; params: unknown };

const REPOS = [{ key: "repo-a", label: "repo-a", path: "/work/repo-a" }];
async function open(tab: "overview" | "rules" | "profiles", ops = OPS, repos = REPOS) {
  const dom = installDom();
  const calls: Call[] = [];
  const api = { call: async (op: string, params: unknown = {}) => {
    calls.push({ op, params });
    if (op === "dispatch.config.get") return view;
    if (op === "dispatch.models") return { models: [], advertised: [], observedAt: null };
    if (op === "dispatch.enforcement" && !repos.length) throw new Error("no repository");
    if (op === "dispatch.enforcement") return { repo: "/work/repo-a", scope: "native", runners: [runner] };
    if (op === "dispatch.enforcement.probe") return { job: { id: "job-1" } };
    if (op === "job.get") return { state: "passed" };
    if (op === "strategy.list") return [];
    if (op === "routing.get") return { rules: [{ executors: ["claude-code"] }], available: ["claude-code"] };
    return {};
  } } as unknown as BrowserApi;
  const state = { ...initialState(), connected: true,
    snapshot: { repos, tasks: [] },
    features: { readModel: true, ops: new Set(ops) } };
  await mount(dom, <TaskContext.Provider value={{ state: state as never, api }}>
    <DispatcherSection query={{ repo: null, scope: null }} tab={tab} />
  </TaskContext.Provider>);
  await act(async () => { await tick(); await tick(); });
  return { dom, calls };
}
const close = async (dom: TestDom) => { await unmount(dom); dom.restore(); };
const settle = () => act(async () => { await tick(); await tick(); });
const ops = (calls: Call[]) => calls.map(call => call.op);
const spending = (calls: Call[]) => calls.filter(call => call.op === "dispatch.enforcement.probe" || call.op === "dispatch.enforcement.consent");

test("Overview shows Native subagent control with the selected repository's executors", async () => {
  const { dom, calls } = await open("overview");
  try {
    await until(() => domText(dom.container).includes("Needs verification"));
    const text = domText(dom.container);
    expect(text).toContain("Native subagent control");
    expect(text).toContain("Verify control");
    expect(text).toContain("Grant consent");
    expect(calls.find(call => call.op === "dispatch.enforcement")?.params).toEqual({ repo: "repo-a" });
    // Opening the page neither probes nor answers consent.
    expect(spending(calls)).toEqual([]);
  } finally { await close(dom); }
});

test("consent is sent only by its button, for that account and answer", async () => {
  for (const [label, granted] of [["Grant consent", true], ["Decline", false]] as const) {
    const { dom, calls } = await open("overview");
    try {
      await until(() => domText(dom.container).includes(label));
      clickText(dom.container, label);
      await settle();
      expect(spending(calls)).toEqual([{ op: "dispatch.enforcement.consent", params: { account: "team", granted } }]);
    } finally { await close(dom); }
  }
});

test("Verify control probes that executor and follows the job", async () => {
  const { dom, calls } = await open("overview");
  try {
    await until(() => domText(dom.container).includes("Verify control"));
    clickText(dom.container, "Verify control");
    await until(() => domText(dom.container).includes("native child blocking verified"));
    expect(spending(calls)).toEqual([{ op: "dispatch.enforcement.probe", params: { repo: "repo-a", runner: "claude-code" } }]);
    expect(calls.find(call => call.op === "job.get")?.params).toEqual({ id: "job-1" });
  } finally { await close(dom); }
});

test("when an action removes or disables the focused button, focus lands on its status, not on another button", async () => {
  for (const [label, status] of [["Verify control", "native child blocking verified"], ["Grant consent", "Consent granted"]] as const) {
    const { dom } = await open("overview");
    try {
      await until(() => domText(dom.container).includes(label));
      clickText(dom.container, label);
      await until(() => domText(dom.container).includes(status));
      await settle();
      const focused = dom.doc.activeElement!;
      expect(focused.getAttribute("role")).toBe("status");
      expect(focused.getAttribute("tabindex") ?? focused.getAttribute("tabIndex")).toBe("-1");
      expect(domText(focused)).toContain(status);
    } finally { await close(dom); }
  }
});

test("a service without certification operations offers no probe or consent", async () => {
  const older = await open("overview", ["dispatch.config.get", "dispatch.models"]);
  try {
    expect(domText(older.dom.container)).toContain("Update the service to inspect managed delegation enforcement.");
    expect(ops(older.calls)).not.toContain("dispatch.enforcement");
  } finally { await close(older.dom); }
  const readOnly = await open("overview", ["dispatch.config.get", "dispatch.models", "dispatch.enforcement"]);
  try {
    await until(() => domText(readOnly.dom.container).includes("Needs verification"));
    expect(domText(readOnly.dom.container)).not.toContain("Verify control");
    expect(domText(readOnly.dom.container)).not.toContain("Grant consent");
  } finally { await close(readOnly.dom); }
});

test("with no registered repository it says so, without a failed or endless status line", async () => {
  const { dom } = await open("overview", OPS, []);
  try {
    const text = domText(dom.container);
    expect(text).toContain("No repository is registered yet, so there is nothing to inspect.");
    expect(text).not.toContain("Native control status");
    expect(text).not.toContain("Loading native control status");
    expect(text).not.toContain("Refresh status");
  } finally { await close(dom); }
});

test("the agents link inside the sentence is underlined, not told apart by nothing", () => {
  const html = renderToString(<DispatcherEnforcementRows reading={{ repo: "/work/repo-a", scope: "native", runners: [{ ...runner, probeSupported: false, unsupportedReason: null }] }}
    canProbe={false} probing={null} onProbe={() => {}} onConsent={() => {}} />);
  expect(html).toContain('<a href="#/settings/agents" class="pc-inline-link">View agents</a>');
});

test("the other Dispatcher tabs do not repeat Native subagent control", async () => {
  for (const tab of ["rules", "profiles"] as const) {
    const { dom, calls } = await open(tab);
    try {
      expect(domText(dom.container)).not.toContain("Native subagent control");
      expect(ops(calls)).not.toContain("dispatch.enforcement");
    } finally { await close(dom); }
  }
});
