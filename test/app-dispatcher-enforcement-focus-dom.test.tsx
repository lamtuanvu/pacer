/** Native subagent control: where focus goes, what its status says, and what cannot be sent twice. */
import { expect, test } from "bun:test";
import { act } from "preact/test-utils";
import type { BrowserApi } from "../app/src/data/api";
import { initialState } from "../app/src/data/store";
import { DispatcherSection } from "../app/src/screens/settings/Dispatcher";
import { TaskContext } from "../app/src/screens/task-shared";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { domText, installDom, mount, tick, until, unmount } from "./app-setup-health-dom";

const view = { strategy: "custom", planner: "claude-code", plannerAccount: "team", source: "strategy", config: dispatchConfigSchema.parse({}) };
const REPOS = [{ key: "repo-a", label: "repo-a", path: "/work/repo-a" }, { key: "repo-b", label: "repo-b", path: "/work/repo-b" }];
const OPS = ["dispatch.config.get", "dispatch.models", "dispatch.enforcement", "dispatch.enforcement.probe", "dispatch.enforcement.consent"];
type Node = any;
type Call = { op: string; params: any };
interface World {
  consent: "unasked" | "granted" | "declined";
  certified: Record<string, "certified" | "uncertified" | "stale">;
  handlers: Partial<Record<string, (params: any) => unknown>>;
}

const all = (root: Node): Node[] => root.childNodes.filter((n: Node) => n.nodeType === 1).flatMap((n: Node) => [n, ...all(n)]);
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function open(options: { world?: Partial<World>; repos?: typeof REPOS; query?: { repo: string | null; scope: null } } = {}) {
  const dom = installDom();
  // The repository picker measures and scrolls its list; the fake DOM only needs those calls to exist.
  const measurable = <N,>(element: N) => Object.assign(element as object, { children: { item: () => null }, getBoundingClientRect: () => ({ top: 0, bottom: 0 }), querySelector: () => null }) as N;
  const create = dom.doc.createElement.bind(dom.doc), createNS = dom.doc.createElementNS.bind(dom.doc);
  // As in a browser, removing the focused element drops focus to nothing at once.
  const blurring = (element: Node) => {
    const remove = element.removeChild.bind(element);
    element.removeChild = (child: Node) => {
      const active = dom.doc.activeElement as Node;
      if (active && (active === child || all(child).includes(active))) dom.doc.activeElement = null;
      return remove(child);
    };
    return element;
  };
  dom.doc.createElement = (tag: string) => blurring(measurable(create(tag)));
  dom.doc.createElementNS = (namespace: string, tag: string) => blurring(measurable(createNS(namespace, tag)));
  const world: World = { consent: "unasked", certified: {}, handlers: {}, ...options.world };
  const repos = options.repos ?? REPOS;
  const calls: Call[] = [];
  const api = { call: async (op: string, params: any = {}) => {
    calls.push({ op, params });
    const handler = world.handlers[op];
    if (handler) return handler(params);
    if (op === "dispatch.config.get") return view;
    if (op === "dispatch.models") return { models: [], advertised: [], observedAt: null };
    if (op === "dispatch.enforcement") {
      const state = world.certified[params.repo] ?? "uncertified";
      return { repo: `/work/${params.repo}`, scope: "native", runners: [{
        runner: "claude-code", account: "team", agent: "claude-code", version: "2.1.281", probeSupported: true, unsupportedReason: null, probeMode: "ask",
        state, ...(state === "certified" ? {} : { reason: state === "stale" ? "Executor or native control configuration changed" : "Native subagent control has not been verified" }),
        lastProbedAt: null, expiresAt: null, nextEligibleAt: 0, probesToday: 0, lastCostPct: null, consent: world.consent }] };
    }
    if (op === "dispatch.enforcement.probe") return { job: { id: "job-1" } };
    if (op === "job.get") { world.certified["repo-a"] = "certified"; return { state: "passed" }; }
    if (op === "dispatch.enforcement.consent") { world.consent = params.granted ? "granted" : "declined"; return {}; }
    return {};
  } } as unknown as BrowserApi;
  let revision = 0;
  const node = () => <TaskContext.Provider value={{ api, state: { ...initialState(), connected: true,
    snapshot: { repos, tasks: [] }, invalidations: revision ? { config: revision } : {},
    features: { readModel: true, ops: new Set(OPS) } } as never }}>
    <DispatcherSection query={options.query ?? { repo: null, scope: null }} tab="overview" />
  </TaskContext.Provider>;
  const settle = () => act(async () => { for (let i = 0; i < 4; i++) await tick(); });
  await mount(dom, node());
  await settle();
  const section = () => all(dom.container).find(n => n.attrs.id === "native-control")!;
  const buttons = () => all(section()).filter(n => n.localName === "button");
  const button = (label: string): Node => {
    const found = buttons().find(n => domText(n).trim() === label);
    if (!found) throw new Error(`no button ${label}: ${buttons().map(domText).join(" | ")}`);
    return found;
  };
  const press = async (label: string, focus = true) => {
    const target = button(label);
    if (focus) target.focus();
    await act(async () => { target.click(); });
    await settle();
    return target;
  };
  /** An unrelated service event: every read refreshes. */
  const refetch = async () => { revision++; await act(async () => { await mount(dom, node()); }); await settle(); };
  const chooseRepo = async (label: string) => {
    const trigger = buttons().find(n => n.attrs["aria-haspopup"] === "listbox")!;
    await act(async () => { trigger.click(); });
    const option = all(section()).find(n => n.attrs.role === "option" && domText(n).trim() === label)!;
    await act(async () => { option.click(); });
    await settle();
  };
  const spending = () => calls.filter(c => c.op === "dispatch.enforcement.probe" || c.op === "dispatch.enforcement.consent");
  const text = () => domText(section());
  const focused = (): Node => dom.doc.activeElement;
  const blur = () => { dom.doc.activeElement = null; };
  const close = async () => { await unmount(dom); dom.restore(); };
  return { world, calls, spending, button, buttons, press, refetch, chooseRepo, section, text, focused, blur, settle, close };
}
type Page = Awaited<ReturnType<typeof open>>;
const withPage = async (options: Parameters<typeof open>[0], run: (page: Page) => Promise<void>) => {
  const page = await open(options);
  try { await run(page); } finally { await page.close(); }
};

for (const [label, message] of [["Verify control", "native child blocking verified"], ["Grant consent", "Consent granted"], ["Decline", "Consent declined"]] as const) {
  test(`${label}: focus moves once, to the status beside that executor`, () => withPage({}, async page => {
    await page.press(label);
    await until(() => page.text().includes(message));
    await page.settle();
    const status = page.focused();
    expect(status.attrs.role).toBe("status");
    expect(status.attrs.class).toBe("pc-action-status");
    expect(String(status.attrs.tabindex ?? status.attrs.tabIndex)).toBe("-1");
    expect(domText(status)).toContain(message);
    // Beside the control that was used: under the probe row, or directly under the consent buttons.
    const siblings = status.parentNode.childNodes.filter((n: Node) => n.nodeType === 1), at = siblings.indexOf(status);
    const before = siblings.slice(0, at).reverse().find((n: Node) => n.attrs.role !== "status" && !String(n.attrs.class).includes("sr-only"));
    if (label === "Verify control") expect(String(before.attrs.class)).toContain("pc-setting-row");
    else expect(String(before.attrs.class)).toContain("u3-setting-consent");
    // Inside the executor's own row, not at the end of the card.
    expect(domText(status.parentNode)).toContain("Claude Code");
    expect(domText(status.parentNode)).not.toContain("Verification starts the selected agent");
    // Later service events never take focus back.
    page.blur();
    await page.refetch();
    await page.refetch();
    expect(page.focused()).toBeNull();
  }));
}

test("focus that moves is brought into view only if its button was in view", async () => {
  for (const [top, expected] of [[100, 1], [-900, 0]] as const) {
    await withPage({}, async page => {
      const grant = page.button("Grant consent");
      grant.getBoundingClientRect = () => ({ top, bottom: top + 32 });
      const scrolls: unknown[] = [];
      for (const status of all(page.section()).filter(n => n.attrs.role === "status")) status.scrollIntoView = (options: unknown) => scrolls.push(options);
      await page.press("Grant consent");
      expect(page.focused().attrs.role).toBe("status");
      expect(scrolls).toEqual(expected ? [{ block: "nearest" }] : []);
    });
  }
});

const resultBesideRow = (page: Page, message: string) => {
  const status = page.focused();
  expect(status?.attrs.role).toBe("status");
  expect(domText(status)).toContain(message);
  return status;
};

test("a reading that removes Verify before the job answers moves focus to that row's status", () => withPage({}, async page => {
  const job = deferred<unknown>();
  page.world.handlers["job.get"] = () => job.promise;
  await page.press("Verify control");
  page.world.certified["repo-a"] = "certified";
  await page.refetch();
  expect(page.buttons().map(domText)).not.toContain("Verify control");
  const status = resultBesideRow(page, "checking native child blocking");
  await act(async () => { job.resolve({ state: "passed" }); });
  await page.settle();
  expect(page.focused()).toBe(status);
  expect(domText(status)).toContain("native child blocking verified");
  page.blur();
  await page.refetch();
  expect(page.focused()).toBeNull();
}));

test("a reading that replaces the consent button before the reply moves focus to its status", () => withPage({}, async page => {
  const reply = deferred<unknown>();
  page.world.handlers["dispatch.enforcement.consent"] = () => reply.promise;
  await page.press("Grant consent");
  page.world.consent = "granted";
  await page.refetch();
  const status = resultBesideRow(page, "Granting consent");
  await act(async () => { reply.resolve({}); });
  await page.settle();
  expect(page.focused()).toBe(status);
  expect(domText(status)).toContain("Consent granted");
  page.blur();
  await page.refetch();
  expect(page.focused()).toBeNull();
}));

for (const where of ["another button", "nowhere"] as const) {
  test(`a reading that removes the button after the user moved to ${where} moves nothing`, () => withPage({}, async page => {
    const job = deferred<unknown>();
    page.world.handlers["job.get"] = () => job.promise;
    await page.press("Verify control");
    const elsewhere = where === "another button" ? page.button("Refresh status") : null;
    if (elsewhere) elsewhere.focus(); else page.blur();
    page.world.certified["repo-a"] = "certified";
    await page.refetch();
    await act(async () => { job.resolve({ state: "passed" }); });
    await page.settle();
    expect(page.focused()).toBe(elsewhere);
  }));
}

test("a claim ends with a failed action: a later removal is not this action's", () => withPage({}, async page => {
  page.world.handlers["dispatch.enforcement.consent"] = () => { throw new Error("consent store locked"); };
  await page.press("Grant consent");
  page.world.consent = "granted";
  await page.refetch();
  expect(page.focused()).toBeNull();
}));

test("a claim ends when the reading after success keeps the button", () => withPage({}, async page => {
  // The service answered, but its next reading does not show the change yet.
  page.world.handlers["dispatch.enforcement.consent"] = () => ({});
  const grant = await page.press("Grant consent");
  expect(page.focused()).toBe(grant);
  page.world.consent = "granted";
  await page.refetch();
  expect(page.focused()).toBeNull();
}));

const REASON = "A check of Claude Code in repo-a is running. Verify control is available when it finishes.";
test("answering consent during a probe keeps the running check's line", () => withPage({}, async page => {
  const job = deferred<unknown>();
  page.world.handlers["job.get"] = () => job.promise;
  await page.press("Verify control");
  await page.press("Grant consent");
  expect(page.text()).toContain("Consent granted");
  expect(page.text()).toContain("Claude Code: checking native child blocking");
  await page.press("Refresh status");
  expect(page.text()).toContain("Claude Code: checking native child blocking");
  expect(page.text()).not.toContain("Consent granted");
  await act(async () => { job.resolve({ state: "failed" }); });
  await page.settle();
  expect(page.text()).not.toContain("checking native child blocking");
  expect(page.text()).toContain("verification could not complete");
}));

test("another repository says why Verify is unavailable while a check runs", () => withPage({}, async page => {
  const job = deferred<unknown>();
  page.world.handlers["job.get"] = () => job.promise;
  await page.press("Verify control");
  expect(page.text()).not.toContain(REASON);
  await page.chooseRepo("repo-b");
  const verify = page.button("Verify control");
  expect(String(verify.attrs["aria-disabled"])).toBe("true");
  expect(String(verify.attrs["aria-busy"])).toBe("false");
  expect(page.text()).toContain(REASON);
  expect(page.text()).not.toContain("checking native child blocking");
  await act(async () => { job.resolve({ state: "failed" }); });
  await page.settle();
  expect(page.text()).not.toContain(REASON);
  expect(page.button("Verify control").attrs["aria-disabled"]).toBeUndefined();
}));

test("a check says it is running as soon as it is asked for", () => withPage({}, async page => {
  page.world.handlers["dispatch.enforcement.probe"] = () => deferred<unknown>().promise;
  await page.press("Verify control");
  expect(page.text()).toContain("Claude Code: checking native child blocking");
}));

test("another repository says why consent is unavailable while an answer is being saved", () => withPage({}, async page => {
  const reply = deferred<unknown>();
  page.world.handlers["dispatch.enforcement.consent"] = () => reply.promise;
  await page.press("Grant consent");
  await page.chooseRepo("repo-b");
  expect(page.text()).toContain("A consent answer is being saved.");
  await act(async () => { reply.resolve({}); });
  await page.settle();
  expect(page.text()).not.toContain("A consent answer is being saved.");
}));

test("an action whose button did not hold focus moves nothing, then or later", () => withPage({}, async page => {
  await page.press("Grant consent", false);
  expect(page.text()).toContain("Consent granted");
  await page.refetch();
  expect(page.focused()).toBeNull();
}));

test("focus the user moved during the action stays where they put it", () => withPage({}, async page => {
  const reply = deferred<unknown>();
  page.world.handlers["dispatch.enforcement.consent"] = () => reply.promise.then(() => { page.world.consent = "granted"; return {}; });
  await page.press("Grant consent");
  const refresh = page.button("Refresh status");
  refresh.focus();
  await act(async () => { reply.resolve({}); });
  await page.settle();
  expect(page.focused()).toBe(refresh);
  page.blur();
  await page.refetch();
  expect(page.focused()).toBeNull();
}));

test("a probe that cannot start leaves focus on its enabled button and says only why", () => withPage({}, async page => {
  const start = deferred<unknown>();
  page.world.handlers["dispatch.enforcement.probe"] = () => start.promise;
  const verify = await page.press("Verify control");
  // Disabling the button here is what drops focus in a browser.
  expect(verify.attrs.disabled).toBeUndefined();
  await act(async () => { start.reject(new Error("offline")); });
  await page.settle();
  expect(page.focused()).toBe(verify);
  expect(page.button("Verify control")).toBe(verify);
  expect(verify.attrs.disabled).toBeUndefined();
  expect(verify.attrs["aria-disabled"]).toBeUndefined();
  expect(page.text()).toContain("Verification could not complete");
  expect(page.text()).not.toContain("checking native child blocking");
}));

test("a probe in flight keeps its button focusable and cannot be started twice", () => withPage({}, async page => {
  const job = deferred<unknown>();
  page.world.handlers["job.get"] = () => job.promise;
  const verify = await page.press("Verify control");
  expect(page.text()).toContain("checking native child blocking");
  expect(page.focused()).toBe(verify);
  expect(verify.attrs.disabled).toBeUndefined();
  expect(String(verify.attrs["aria-disabled"])).toBe("true");
  await page.refetch();
  expect(page.focused()).toBe(verify);
  await page.press("Verify control");
  expect(page.spending()).toHaveLength(1);
  await act(async () => { job.reject(new Error("gone")); });
  await page.settle();
  // The in-progress line goes with the failed job read.
  expect(page.text()).not.toContain("checking native child blocking");
  expect(page.text()).toContain("Verification could not complete");
  expect(page.focused()).toBe(verify);
}));

test("consent buttons ignore repeats and opposite answers while a request is in flight", () => withPage({}, async page => {
  const reply = deferred<unknown>();
  page.world.handlers["dispatch.enforcement.consent"] = () => reply.promise;
  const grant = await page.press("Grant consent");
  for (const label of ["Grant consent", "Decline"]) {
    expect(String(page.button(label).attrs["aria-disabled"])).toBe("true");
    expect(page.button(label).attrs.disabled).toBeUndefined();
  }
  expect(page.focused()).toBe(grant);
  await page.press("Grant consent");
  await page.press("Grant consent");
  await page.press("Decline");
  expect(page.spending()).toEqual([{ op: "dispatch.enforcement.consent", params: { account: "team", granted: true } }]);
  await act(async () => { reply.resolve({}); });
  await page.settle();
  expect(page.button("Grant consent").attrs["aria-disabled"]).toBeUndefined();
}));

test("a button that is still there keeps focus when the follow-up read fails", () => withPage({}, async page => {
  page.world.handlers["dispatch.enforcement.consent"] = () => {
    page.world.handlers["dispatch.enforcement"] = () => { throw new Error("read failed"); };
    return {};
  };
  const grant = await page.press("Grant consent");
  expect(page.text()).toContain("Consent granted");
  expect(page.focused()).toBe(grant);
}));

for (const label of ["Grant consent", "Verify control"]) {
  test(`two presses of ${label} before the screen redraws send one request`, () => withPage({}, async page => {
    const reply = deferred<unknown>();
    page.world.handlers["dispatch.enforcement.consent"] = () => reply.promise;
    page.world.handlers["dispatch.enforcement.probe"] = () => reply.promise;
    const target = page.button(label);
    await act(async () => { target.click(); target.click(); });
    expect(page.spending()).toHaveLength(1);
    await act(async () => { reply.reject(new Error("done")); });
    await page.settle();
  }));
}

test("a failed consent drops its in-progress line, and the next answer drops the error", () => withPage({}, async page => {
  page.world.handlers["dispatch.enforcement.consent"] = () => { throw new Error("consent store locked"); };
  const grant = await page.press("Grant consent");
  expect(page.text()).toContain("consent store locked");
  expect(page.text()).not.toContain("Granting consent");
  expect(page.focused()).toBe(grant);
  delete page.world.handlers["dispatch.enforcement.consent"];
  await page.press("Grant consent");
  expect(page.text()).toContain("Consent granted");
  expect(page.text()).not.toContain("consent store locked");
}));

test("Refresh status clears a settled message", () => withPage({}, async page => {
  await page.press("Grant consent");
  expect(page.text()).toContain("Consent granted");
  await page.press("Refresh status");
  expect(page.text()).not.toContain("Consent granted");
}));

test("a result is shown only under the repository it came from", () => withPage({ world: { certified: { "repo-b": "stale" } } }, async page => {
  await page.press("Verify control");
  expect(page.text()).toContain("native child blocking verified");
  await page.chooseRepo("repo-b");
  expect(page.text()).toContain("Verification expired");
  expect(page.text()).not.toContain("native child blocking verified");
  await page.chooseRepo("repo-a");
  expect(page.text()).toContain("native child blocking verified");
}));

test("a verified message goes away when a later reading says the certificate expired", () => withPage({}, async page => {
  await page.press("Verify control");
  expect(page.text()).toContain("native child blocking verified");
  page.world.certified["repo-a"] = "stale";
  await page.refetch();
  expect(page.text()).toContain("Verification expired");
  expect(page.text()).not.toContain("native child blocking verified");
}));

for (const [name, query] of [["no link", { repo: null, scope: null }], ["a stale repository link", { repo: "gone", scope: null }]] as const) {
  test(`with no registered repository and ${name}, nothing is read`, () => withPage({ repos: [], query }, async page => {
    expect(page.text()).toContain("No repository is registered yet");
    expect(page.text()).not.toContain("Refresh status");
    expect(page.text()).not.toContain("could not be loaded");
    await page.refetch();
    expect(page.calls.filter(c => c.op === "dispatch.enforcement")).toEqual([]);
  }));
}

test("the focused status has a design-system focus ring that outranks the tabindex reset", async () => {
  const css = await Bun.file(new URL("../app/src/ds/components.css", import.meta.url)).text();
  expect(css).toMatch(/\.pc-action-status:focus\{outline:var\(--stroke-focus\) solid var\(--focus\);outline-offset:var\(--stroke-focus\);border-radius:var\(--radius-sm\)\}/);
});
