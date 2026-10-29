import { eligibility } from "./fixtures/eligibility";
import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { emptySnapshot } from "../src/link/envelope";
import type { ClientSnapshot, ClientTask } from "../src/view-model/snapshot";
import type { ExecutorRow } from "../src/api/read-model/types";
import { initialState, reduceStore } from "../app/src/data/store";
import { createApi } from "../app/src/data/api";
import { Tray, moveFocus, performAction } from "../app/src/tray/Tray";
import { createTrayIpc } from "../app/src/tray/ipc";
import { actionRoute, executorValue, resetCaption, shortTitle, trayModel } from "../app/src/tray/model";
import { buildApp } from "../app/build";
import { appRoute, APP_HEADERS } from "../src/serve/app-routes";
import { fakeCtx } from "./helpers";

function fixture(): ClientSnapshot {
  const task = (i: number): ClientTask & { title: string } => ({ id: `task-${i}`, title: `Fix retry ${i}`, goal: `A long detailed goal ${"with many words ".repeat(12)}`, state: "running", executor: "codex", backend: null, worktree: null, updatedAt: 100, attemptStartedAt: 100, progress: { phase: i === 1 ? "idle" : "testing", lastOutputAt: 200, files: 1, commits: 0, logBytes: 10 } });
  const executor: ExecutorRow = { eligibility: eligibility(), id: "codex#team", agent: "codex", account: "team", host: null, model: null, rank: 1, enabled: true, state: "busy", tone: "info", sub: "Working", usedPct: 41, pacePct: 58, slots: { used: 1, max: 2 }, lastCheck: null, recentFailures: 0, next: true };
  return {
    ...emptySnapshot(), at: 1000,
    planner: { runner: "gemini", agent: "gemini", usedPct: 63, pacePct: 77, deltaPts: -14, verdict: "behind", activeHoursLeft: 5, resetsAt: 2000, window: "week", stale: false, advice: "Available", mode: "normal" },
    tasks: [0, 1].map<ClientTask>(i => ({ ...task(i), repo: { key: "pacer", label: "pacer", path: "$HOME/pacer" } })).concat(Array.from({ length: 14 }, (_, i) => ({ ...task(i + 5), title: i ? `Queued task ${i}` : "Review screen", state: "queued", queue: { reason: "no_slot" as const, since: 100, position: i + 1 } }))),
    today: { since: 0, done: 3, accepted: 0, rejected: 0, failed: 0, byRepo: {} },
    attention: [0, 1, 2, 3, 4].map(i => ({ id: `attention-${i}`, kind: i === 1 ? "question" : i === 2 ? "review" : "failed", severity: "problem", repo: { key: "pacer", label: "pacer", path: "$HOME/pacer" }, taskId: `task-${i}`, title: `Attention ${i}`, detail: `Failed twice ${i}`, raisedAt: i, since: i, notify: "all", actions: [{ label: i === 1 ? "Answer" : i === 2 ? "Review" : "Retry", ...(i === 0 ? { style: "primary" as const } : {}), op: "task.retry", params: { id: `task-${i}`, executor: "codex" } }, { label: "See error", op: "ui.open", params: { view: "task", id: `task-${i}` } }] })),
    executors: [executor, { ...executor, id: "cursor", agent: "cursor", eligibility: { ...eligibility("ineligible"), reasons: [{ code: "unavailable", evidenceIds: [] }] }, state: "down", tone: "bad", usedPct: 92, pacePct: null }],
    strategies: [{ name: "default", active: true, summary: "Default", description: "" }, "weekend"],
    pause: null,
    // The tray must ignore stale budget-provider usage for executors.
    budget: { generatedAt: 1, planner: "gemini", strategy: "default", mode: "normal", providers: [{ id: "codex#team", verdict: "OK", usedPct: 99, pacePct: 99, resetsAt: null, window: null, stale: false }], ranked: [] },
  };
}
const api = createApi();
const ipc = createTrayIpc({ location: { assign() {} } });
const draw = (snapshot: ClientSnapshot) => renderToString(<Tray snapshot={snapshot} api={api} ipc={ipc} />);
const section = (html: string, name: string) => html.split(new RegExp(`<section(?=[^>]*class="[^"]*tray-section)(?=[^>]*aria-label="${name}")[^>]*>`))[1]!.split("</section>")[0]!;

test("busy board has four linked counts, three attention rows, two running rows and one waiting line", () => {
  const snapshot = fixture(), html = draw(snapshot);
  const attention = section(html, "Needs you"), active = section(html, "Running");
  expect(attention.match(/class="[^"]*tray-attention /g)).toHaveLength(3);
  expect(attention).toContain('All 5 in Needs you');
  expect(attention).not.toContain("Attention 3");
  expect(attention).toContain("pacer · Testing · Failed twice 0");
  expect(attention).toContain('href="/app/#/needs-you"');
  expect(attention.match(/pc-btn--primary/g)).toHaveLength(1);
  expect(attention.match(/<button/g)).toHaveLength(3);
  expect(attention).toContain('pc-btn--compact');
  expect(attention.match(/pc-list-row__actions/g)).toHaveLength(3);
  expect(attention).toContain(">Answer</span></button>");
  expect(attention).toContain(">Review</span></button>");
  expect(active.match(/class="[^"]*tray-running"/g)).toHaveLength(2);
  expect(active).toContain('Idle</span><span class="tray-ellipsis">\u00a0· 15 min');
  expect(active).toContain("tray-running-caption");
  expect(active).not.toContain("Queued");
  expect(html).toContain("14 waiting for a free Codex slot · next: Review screen");
  const counts = html.split(/<nav(?=[^>]*aria-label="Task counts")[^>]*>/)[1]!.split("</nav>")[0]!;
  for (const [n, label, route] of [[5, "needs you", "/needs-you"], [2, "running", "/sessions"], [14, "waiting", "/tasks"], [3, "done today", "/tasks"]]) {
    expect(counts).toContain(`href="/app/#${route}"`);
    expect(counts).toContain(`>${n}</b><span>${label}</span>`);
  }
  expect(counts).toContain('class="tray-idle">5');
  expect(trayModel({ ...snapshot, attention: undefined }).attention).toEqual([]);
});

test("running captions combine phase, readable duration and repository", () => {
  const snapshot = fixture();
  const task = snapshot.tasks[0]!;
  snapshot.tasks = [{ ...task, attemptStartedAt: snapshot.at - 120, progress: { ...task.progress!, phase: "working" }, repo: { key: "repo", label: "repo", path: "$HOME/repo" } }];
  const caption = draw(snapshot);
  expect(caption).toContain('Editing</span><span class="tray-ellipsis">\u00a0· 2 min\u00a0· repo');
});

test("all-clear board uses a green check, optional cleared review time and no waiting row", () => {
  const snapshot = fixture();
  const clear = { ...snapshot, attention: [], tasks: [{ ...snapshot.tasks[0]!, state: "done", review: { accepted: true, kind: null, note: null, at: 900 } }] };
  const html = draw(clear);
  expect(html).toContain("Nothing needs you");
  expect(html).toContain('class="tray-check"');
  expect(html).toContain("Last review cleared ");
  expect(html).toContain('class="tray-muted">0');
  expect(html).not.toContain('class="tray-waiting"');
  expect(draw({ ...clear, tasks: [] })).not.toContain("Last review cleared");
  const activity = [{ id: "review", kind: "verdict" as const, level: "info" as const, at: 950, text: "Accepted a task" }];
  expect(renderToString(<Tray snapshot={{ ...clear, tasks: [] }} api={api} ipc={ipc} activity={activity} />)).toContain("Last review cleared");
});

test("planner uses its vendor, verdict, mode, meter tick and reset time", () => {
  const html = draw(fixture());
  expect(html).toContain("Gemini</strong>");
  expect(html).toContain('<strong title="Gemini planner">Gemini</strong>');
  expect(html).toContain("pc-agent-mark--gemini");
  expect(html).not.toContain("Claude");
  expect(html).toContain(">Behind pace</span>");
  expect(html).toContain(">Normal</span>");
  expect(html).toContain("63% of week used · pace 77%");
  expect(html).toContain("pc-meter__pace");
  expect(html).toContain("resets ");
});

test("executor marks use current capacity, values and detailed tooltips after entity updates", () => {
  const snapshot = fixture(), html = draw(snapshot);
  expect(html).toContain("41% used · pace 58%");
  expect(html).toContain("Cursor: unavailable");
  expect(html).toContain("1 off");
  expect(html).not.toContain("99% used");
  const executor = snapshot.executors![0]!;
  expect(executorValue(executor)).toBe("41%");
  expect(executorValue({ ...executor, slots: { used: 2, max: 2 } })).toBe("41%");
  expect(executorValue({ ...executor, eligibility: undefined, state: "exhausted" })).toBe("out");
  expect(executorValue({ ...executor, enabled: false })).toBe("off");
  expect(executorValue({ ...executor, eligibility: undefined, sub: "No active plan" })).toBe("off");
  expect(executorValue({ ...executor, usedPct: null, slots: { used: 0, max: 2 } })).toBe("?");
  const state = reduceStore({ ...initialState(), snapshot, needsSnapshot: false, features: { readModel: true, ops: new Set() } }, { type: "event", event: { type: "executor", seq: 1, at: 1001, data: { ...executor, usedPct: 47, state: "full", tone: "warn", slots: { used: 2, max: 2 } } } });
  expect(draw(state.snapshot!)).toContain("47% used · pace 58%");
  expect(draw(state.snapshot!)).toContain(">47%</span>");
});

test("task titles are preferred and legacy goals remain complete for CSS clipping", () => {
  const snapshot = fixture(), html = draw(snapshot);
  expect(html).toContain("Fix retry 0");
  expect(html).not.toContain("A long detailed goal");
  const goal = "Repair the retry system in /tmp/project/src/index.ts before adding more checks for all existing background workers";
  const title = shortTitle({ goal });
  expect(title).toBe(goal);
  expect(shortTitle({ title: "Short service title", goal })).toBe("Short service title");
  const legacy: ClientSnapshot = { ...snapshot, tasks: [{ ...snapshot.tasks[0]!, title: undefined, goal } as ClientTask] };
  expect(draw(legacy)).toContain(title);
});

test("ahead and paused board has warn fill, Paused chip, resume icon and paused waiting minutes", () => {
  const snapshot = fixture();
  expect(draw(snapshot)).toContain('aria-label="Pause delegation for 1 hour"');
  const html = draw({ ...snapshot, planner: { ...snapshot.planner!, verdict: "ahead", usedPct: 82, pacePct: 64 }, pause: { until: 3280, reason: null, by: "app" }, tasks: snapshot.tasks.filter(task => task.state === "queued").slice(0, 3) });
  expect(html).toContain("pc-meter__fill--warn");
  expect(html).toContain(">Ahead of pace</span>");
  expect(html).toContain(">Paused</span>");
  expect(html).toContain('aria-label="Resume delegation"');
  expect(html).toContain('d="M8 5l11 7-11 7z"');
  expect(html).toContain(" · 3 tasks waiting");
  expect(html).toContain("Delegation paused");
  expect(html).toContain("New work waits until ");
  expect(html).not.toContain(" · paused until ");
  expect(html).not.toContain('aria-label="Running"');
  expect(html).toContain('aria-label="More" aria-expanded="false"');
  expect(html).not.toContain("Switch strategy");
});

test("browser IPC degrades to app links; resize, hide and quit are safe no-ops", async () => {
  const urls: string[] = [];
  const browser = createTrayIpc({ location: { assign: url => { urls.push(url); } } });
  expect(browser.desktop).toBe(false);
  await browser.open("/sessions/test");
  await browser.resize(999);
  await browser.hide();
  await browser.quit();
  expect(urls).toEqual(["/app/#/sessions/test"]);
  await createTrayIpc(undefined).hide();
  expect(draw(fixture())).toContain('href="/app/#/"');
});

test("desktop IPC uses only the shared commands and caps rounded height at 560", async () => {
  const calls: unknown[] = [];
  const desktop = createTrayIpc({ __TAURI__: { core: { invoke: async (command, args) => { calls.push([command, args]); } } }, location: { assign() { throw Error("Unexpected browser fallback"); } } });
  await desktop.resize(300.2); await desktop.resize(900); await desktop.open("/"); await desktop.hide(); await desktop.quit();
  expect(calls).toEqual([["tray_resize", { height: 301 }], ["tray_resize", { height: 560 }], ["tray_open", { route: "/" }], ["tray_hide", undefined], ["app_quit", undefined]]);
});

test("primary op action posts the item's exact params with the app client header", async () => {
  const prior = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/hello")) return Response.json({ protocol: "3.0.0", pacer: "0.2.3", ops: [], events: [] });
    request = { url: String(url), init };
    return Response.json({ result: {} });
  }) as typeof fetch;
  try {
    const item = fixture().attention![0]!;
    await performAction(item.actions[0]!, createApi(), ipc);
    expect(request?.url).toBe("/v3/ops/task.retry");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.credentials).toBe("same-origin");
    expect(new Headers(request?.init?.headers).get("X-Pacer-Client")).toBe("app");
    expect(JSON.parse(String(request?.init?.body))).toEqual(item.actions[0]!.params);
  } finally { globalThis.fetch = prior; }
});

test("ui.open navigates through IPC and never calls the operation API", async () => {
  const routes: string[] = [];
  const browser = createTrayIpc({ location: { assign: url => { routes.push(url); } } });
  await performAction({ label: "Review", op: "ui.open", params: { view: "review", id: "task 1" } }, { ...api, call: async () => { throw Error("Must not POST ui.open"); } }, browser);
  expect(routes).toEqual(["/app/#/sessions/task%201"]);
  expect(actionRoute({ label: "Open", op: "ui.open", params: { route: "/settings" } })).toBe("/settings");
});

test("arrow keys navigate rows and wrap; Tab and Enter retain native handling", () => {
  const doc = { activeElement: null as unknown };
  const rows = [0, 1, 2].map(() => ({ focus() { doc.activeElement = this; } }));
  const root = { querySelectorAll: () => rows, ownerDocument: doc } as unknown as HTMLElement;
  expect(moveFocus(root, "ArrowDown")).toBe(true);
  expect(doc.activeElement).toBe(rows[0]);
  moveFocus(root, "ArrowUp"); expect(doc.activeElement).toBe(rows[2]);
  moveFocus(root, "Home"); expect(doc.activeElement).toBe(rows[0]);
  moveFocus(root, "End"); expect(doc.activeElement).toBe(rows[2]);
  expect(moveFocus(root, "Tab")).toBe(false);
  expect(moveFocus(root, "Enter")).toBe(false);
});

test("tray assets use their own entry and external CSS and are served with the app CSP", async () => {
  const files = await buildApp();
  const html = files.find(f => f.path === "tray.html")!.text;
  expect(html).toContain('src="/app/tray.js"');
  expect(html).toContain('href="/app/tray.css"');
  expect(html).not.toMatch(/\sstyle=|\son\w+=|<style\b/i);
  expect(html).not.toMatch(/<script\b[^>]*>\s*\S[\s\S]*?<\/script\s*>/i);
  const js = files.find(f => f.path === "tray.js")!.text;
  expect(js).toContain("/v2/events?since=");
  expect(js).toContain("tray_resize");
  const css = files.find(f => f.path === "tray.css")!.text;
  expect(css).toContain("prefers-color-scheme: dark");
  expect(css).toContain("focus-visible");
  expect(css).toContain("width:var(--size-340)");
  expect(css).toContain("max-height:var(--size-560)");
  expect(css).toContain("font-variant-numeric:tabular-nums");
  expect(js).toContain("/settings");
  expect(js).toContain("strategy.use");
  expect(js).toContain("delegation.resume");
  for (const name of ["tray.html", "tray.js", "tray.css"]) {
    const response = appRoute(new Request(`http://localhost:4317/app/${name}`), fakeCtx());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(APP_HEADERS["Content-Security-Policy"]);
    expect(await response.text()).toBe(files.find(f => f.path === name)!.text);
  }
});

test("row actions show one short verb and keep the full label as a tooltip", async () => {
  const { rowLabel } = await import("../app/src/tray/Tray");
  expect(rowLabel("Retry on OpenCode")).toBe("Retry on OpenCode");
  expect(rowLabel("Review")).toBe("Review");
  expect(rowLabel("Review changes")).toBe("Review");
  expect(rowLabel("Inspect failures")).toBe("Inspect");
  expect(rowLabel("Run checks")).toBe("Run checks");
  expect(rowLabel("Open settings")).toBe("Settings");
});

test("tray action destinations use mounted screens and preserve settings sections", () => {
  const route = (params: Record<string, unknown>) => actionRoute({ label: "Open", op: "ui.open", params });
  expect(route({view:"task",id:"running 1"})).toBe("/sessions/running%201");
  expect(route({view:"review",id:"done 1"})).toBe("/sessions/done%201");
  expect(route({view:"settings",section:"executors"})).toBe("/settings/executors");
  expect(route({view:"settings",section:"routing"})).toBe("/settings/dispatcher");
  expect(route({view:"settings",section:"strategies"})).toBe("/settings/dispatcher");
  for (const [view, to] of Object.entries({executors:"/settings/executors",accounts:"/settings/accounts",hosts:"/settings/hosts",strategy:"/settings/dispatcher",setup:"/",tasks:"/sessions"})) expect(route({view})).toBe(to);
});

test("long settings actions shorten to Settings and labels ellipsize instead of overflowing", async () => {
  const { rowLabel } = await import("../app/src/tray/Tray");
  expect(rowLabel("Open planner settings")).toBe("Settings");
  expect(rowLabel("Open settings")).toBe("Settings");
  expect(rowLabel("Retry on Codex")).toBe("Retry on Codex");
  const css = (await buildApp()).find(f => f.path === "tray.css")!.text;
  expect(css).toMatch(/\.tray-action__label\{[^}]*text-overflow:ellipsis/);
});

test("opencode executors use their account's mark and an unavailable account reads off", () => {
  const row = (id: string, account: string, extra: Partial<ExecutorRow> = {}): ExecutorRow => ({ id, agent: "opencode", account, host: null, model: null, rank: 2, enabled: true, state: "ready", tone: "good", sub: "", usedPct: null, pacePct: null, slots: { used: 0, max: 1 }, lastCheck: null, recentFailures: 0, next: false, ...extra });
  const byteplus = row("opencode#byteplus", "byteplus", { state: "down", tone: "bad", sub: "Unavailable", reason: "no active coding-plan subscription" });
  const local = row("opencode#local", "local", { state: "ready", tone: "good", paceReason: "unmetered" });
  expect(executorValue(byteplus)).toBe("off");
  expect(executorValue(local)).toBe("—");
  const html = draw({ ...fixture(), executors: [byteplus, local] });
  expect(html).toContain("BytePlus:");
  expect(html).toContain("agent-mark--local");
  expect(html).not.toContain("agent-mark--opencode");
  expect(html).toContain("1 off</a>");
});


test("Needs-you reasons show the shared status once and preserve distinct evidence", () => {
  const snapshot = fixture();
  const review = { ...snapshot.attention![2]!, detail: "Review requested" };
  const html = section(draw({ ...snapshot, attention: [review] }), "Needs you");
  expect(html).toContain("pacer · Review requested</span>");
  expect(html).not.toContain("Review requested · Review requested");
  expect(section(draw({ ...snapshot, attention: [{ ...review, detail: "Checks passed" }] }), "Needs you"))
    .toContain("pacer · Review requested · Checks passed");
});

test("unknown capacity never reads free or shows a ready glyph; unavailable capacity stays dimmed", () => {
  const base = fixture().executors![0]!;
  const unknown: ExecutorRow = { ...base, eligibility: undefined, id: "opencode#byteplus", agent: "opencode", account: "byteplus", state: "ready", tone: "good", sub: "Usage unknown", usedPct: null, pacePct: null, paceReason: "no limit reported", slots: { used: 0, max: 1 } };
  for (const slots of [{ used: 0, max: 1 }, { used: 1, max: 1 }]) {
    const row = { ...unknown, slots };
    expect(executorValue(row)).toBe("?");
    const html = draw({ ...fixture(), executors: [row] });
    expect(html).toContain(">?</span>");
    expect(html).not.toContain("tray-executor-glyph");
    expect(html).toContain("tray-executor-value--muted");
    expect(html.split(/<section(?=[^>]*aria-label="Executors")[^>]*>/)[1]!.split("</section>")[0]!).not.toContain("pc-glyph pc-status--good");
    expect(html).not.toContain(">free</span>");
  }
  for (const row of [
    { ...unknown, state: "down" as const, tone: "bad" as const, reason: "no active coding-plan subscription" },
    { ...unknown, reason: "no subscription" },
    { ...unknown, enabled: false },
  ]) {
    expect(executorValue(row)).toBe("off");
    const html = draw({ ...fixture(), executors: [row] });
    expect(html).toContain("tray-executor--off");
    expect(html).toContain(">1 off</a>");
    expect(html.split(/<section(?=[^>]*aria-label="Executors")[^>]*>/)[1]!.split("</section>")[0]!).not.toContain("pc-glyph pc-status--good");
  }
  expect(executorValue({ ...unknown, paceReason: "unmetered" })).toBe("—");
  expect(executorValue({ ...unknown, state: "checking", paceReason: "unmetered" })).toBe("?");
});

test('Escape dismisses tray menus before hiding and reports native hide failures',async()=>{
 const { dismissTray }=await import('../app/src/tray/Tray');
 const steps:string[]=[];
 await dismissTray(()=>steps.push('closed'),async()=>{steps.push('hidden');},message=>steps.push(message));
 expect(steps).toEqual(['closed','hidden']);
 await dismissTray(()=>steps.push('closed'),async()=>{throw new Error('Native hide failed');},message=>steps.push(message));
 expect(steps.slice(-2)).toEqual(['closed','Native hide failed']);
});

test("footer starts a task and tray has no platform glyph controls", () => {
  const html = draw(fixture());
  expect(html).toContain('href="/app/#/tasks/new"');
  expect(html).toContain('New task <kbd');
  expect(html).toContain('⌘N');
  expect(html).not.toMatch(/[⏸▶⋯⏳]/);
});

test("running rows cap at two while the section links the full count", () => {
  const snapshot = fixture();
  snapshot.tasks.push({ ...snapshot.tasks[0]!, id: "third" });
  const active = section(draw(snapshot), "Running");
  expect(active.match(/class="[^"]*tray-running"/g)).toHaveLength(2);
  expect(active).toContain("All 3 in Tasks");
});

test("paused indefinitely omits zero waiting and uses singular task copy", () => {
  const snapshot = fixture();
  snapshot.pause = { until: null, reason: null, by: "app" };
  expect(draw({ ...snapshot, tasks: [] })).toContain("New work waits until you resume</span>");
  expect(draw({ ...snapshot, tasks: snapshot.tasks.filter(t => t.state === "queued").slice(0, 1) })).toContain(" · 1 task waiting");
});


test("tray literal destinations and generated row/action routes share the desktop contract", async () => {
  const cases = await Bun.file("test/fixtures/tray-routes.json").json() as {allowed: string[]; rejected: string[]};
  const allowed = (raw: string) => {
    if (raw.includes("#") || raw.includes("\\") || raw.includes("..")) return false;
    if (/^\/needs-you\?answer=t-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(raw)) return true;
    if (raw.includes("?")) return false;
    return raw === "/" || raw === "/needs-you" || /^\/(?:review|sessions|tasks|settings)(?:\/[A-Za-z0-9_-]+)?$/.test(raw) || /^\/settings\/hosts\/[A-Za-z0-9_-]+$/.test(raw);
  };
  for (const route of cases.allowed) expect(allowed(route)).toBe(true);
  for (const route of cases.rejected) expect(allowed(route)).toBe(false);
  const source = await Bun.file("app/src/tray/Tray.tsx").text();
  const literals = [...source.matchAll(/(?:appHref|navigate|ipc.open)\("([^"`]+)"\)|route: "([^"`]+)"/g)].map(match => match[1] ?? match[2]!);
  const modelSource = await Bun.file("app/src/tray/model.ts").text();
  literals.push(...[...modelSource.matchAll(/"(\/[^"\n]*)"/g)].map(match => match[1]!));
  const updateSource = await Bun.file("src/view-model/updates.ts").text();
  literals.push(...[...updateSource.matchAll(/route: "(\/[^"\n]*)"/g)].map(match => match[1]!));
  expect(literals.length).toBeGreaterThan(15);
  for (const route of literals) { expect(cases.allowed).toContain(route); expect(allowed(route)).toBe(true); }
  const html = draw({...fixture(), tasks: [{...fixture().tasks[0]!,id:"task-1"}]});
  for (const match of html.matchAll(/href="\/app\/#([^"]+)"/g)) expect(cases.allowed).toContain(match[1]!);
  const routes: string[] = [];
  await performAction({label:"Answer",op:"task.answer",params:{id:"t-20261029-153500-a0f9"}}, api, {...ipc,desktop:true,open:async route=>{routes.push(route);}});
  expect(routes).toEqual(["/needs-you?answer=t-20261029-153500-a0f9"]);
  expect(cases.allowed).toContain(routes[0]!);
});

test("only the first visible failed or limit retry with a named executor is recommended", () => {
  const snapshot = fixture();
  const failed = snapshot.attention![0]!;
  snapshot.attention = Array.from({length:5},(_,i)=>({...failed,id:`failed-${i}`,kind:"failed" as const,actions:[{label:"Retry on Codex",op:"task.retry",params:{id:`task-${i}`,executor:"codex"}}]}));
  expect(trayModel(snapshot).recommendedId).toBe("failed-0");
  expect(section(draw(snapshot),"Needs you").match(/pc-btn--primary/g)).toHaveLength(1);
  snapshot.attention[0]!.kind="limit";
  expect(trayModel(snapshot).recommendedId).toBe("failed-0");
  snapshot.attention[0]!.actions=[];
  expect(trayModel(snapshot).recommendedId).toBe("failed-1");
  expect(section(draw(snapshot),"Needs you").match(/<button/g)).toHaveLength(2);
  snapshot.attention.slice(0,3).forEach(item=>{item.actions=[];});
  expect(trayModel(snapshot).recommendedId).toBeUndefined();
  expect(section(draw(snapshot),"Needs you")).not.toContain("<button");
});

test("running without a repo has no trailing separator and shortcuts have metadata", () => {
 const snapshot=fixture(); snapshot.tasks=[{...snapshot.tasks[0]!,repo:undefined}];
 const html=draw(snapshot);
 expect(section(html,"Running")).not.toMatch(/·\s*<\/span>/);
 for(const key of ["Meta+N","Meta+O"]) expect(html).toContain(`aria-keyshortcuts="${key}"`);
});

test("ArrowUp without a focused row starts at the last row", () => {
 const doc={activeElement:null as unknown};
 const rows=[0,1,2].map(()=>({focus(){doc.activeElement=this;}}));
 moveFocus({querySelectorAll:()=>rows,ownerDocument:doc} as unknown as HTMLElement,"ArrowUp");
 expect(doc.activeElement).toBe(rows[2]);
});


test("executor warning and bad tones keep board percentages with status in the tooltip", () => {
  const snapshot = fixture();
  for (const verdict of ["ahead", "out"] as const) {
    const executor = { ...snapshot.executors![0]!, usedPct: 90 };
    const html = draw({ ...snapshot, accounts: [{ name: executor.account, executors: [executor.id], verdict } as any], executors: [executor] }).split(/<section(?=[^>]*aria-label="Executors")[^>]*>/)[1]!.split("</section>")[0]!;
    expect(html).not.toContain("tray-executor-glyph");
    expect(html).toContain("90%</span>");
  }
test("Answer opens the task at its answer box through a route the native shell accepts", async () => {
  const route = actionRoute({ label: "Answer", op: "ui.open", params: { view: "task", id: "t-20261029-190507-4d5a", tab: "answer" } });
  expect(route).toBe("/sessions/t-20261029-190507-4d5a/answer");
  // Same rules as desktop logic::route: no query string, and only review|sessions|settings.
  expect(route).not.toContain("?");
  expect(route).toMatch(/^\/sessions\/[A-Za-z0-9_-]+\/answer$/);
  const opened: string[] = [];
  const native = createTrayIpc({ __TAURI__: { core: { invoke: async (command, args) => { opened.push(`${command} ${String(args?.route)}`); } } }, location: { assign: () => { throw Error("native must not assign"); } } });
  await performAction({ label: "Answer", op: "ui.open", params: { view: "task", id: "t-1", tab: "answer" } }, api, native);
  await performAction({ label: "Answer", op: "task.answer", params: { id: "t-2" } }, api, native);
  expect(opened).toEqual(["tray_open /sessions/t-1/answer", "tray_open /sessions/t-2/answer"]);
  const browser: string[] = [];
  await performAction({ label: "Answer", op: "ui.open", params: { view: "task", id: "t-1", tab: "answer" } }, api, createTrayIpc({ location: { assign: url => { browser.push(url); } } }));
  expect(browser).toEqual(["/app/#/sessions/t-1/answer"]);
});

test("a failed tray action gives a plain reason and a next step", async () => {
  const { actionError } = await import("../app/src/tray/model");
  expect(actionError("Invalid route")).toBe("pacer could not open that. Try again, or open pacer to finish there.");
  expect(actionError(undefined)).toBe("pacer could not open that. Try again, or open pacer to finish there.");
  expect(actionError(new Error("Task already finished."))).toBe("Task already finished. Try again, or open pacer to finish there.");
});


test("eligible Codex with 17% usage ignores failing/checking legacy state and stale plan prose", () => {
  const snapshot = fixture();
  const codex: ExecutorRow = { ...snapshot.executors![0]!, id: "codex", account: "codex", usedPct: 17, pacePct: 17,
    eligibility: eligibility(), state: "failing", sub: "2 recent failures", reason: "2 recent failures", recentFailures: 2,
    slots: { used: 0, max: 16 }, lastCheck: { at: 900, passed: false, detail: "failed check" } };
  expect(executorValue(codex)).toBe("17%");
  for (const state of ["failing", "down", "blocked", "checking"] as const) {
    expect(executorValue({ ...codex, state, sub: "No active plan" })).toBe("17%");
  }
  expect(draw({ ...snapshot, executors: [codex] })).toContain("17% used · pace 17%");
  expect(draw({ ...snapshot, executors: [codex] })).toContain(">17%</span>");
});

test("executor strip omits the planner by rank or identity and groups off executors", () => {
  const snapshot = fixture(), row = snapshot.executors![0]!;
  const html = draw({ ...snapshot, executors: [
    { ...row, id: snapshot.planner!.runner }, { ...row, id: "planner-alias", rank: "planner" }, row,
    { ...row, id: "disabled-one", enabled: false }, { ...row, id: "disabled-two", state: "disabled" },
  ] }).split('aria-label="Executors"')[1]!.split("</section>")[0]!;
  expect(html).not.toContain("planner-alias");
  expect(html).not.toContain("agent-mark--gemini");
  expect(html).toContain("2 off</a>");
  expect(html).toContain("turned off");
});

test("needs-you uses the board's waiting and failure glyphs", () => {
  const html = section(draw(fixture()), "Needs you");
  expect(html.match(/>◐<\/span>/g)).toHaveLength(1);
  expect(html).toContain('tray-attention-glyph--info');
  expect(html.match(/>●<\/span>/g)).toHaveLength(1);
  expect(html.match(/>✕<\/span>/g)).toHaveLength(1);
  expect(html).not.toContain(">!</span>");
});

test("reset caption uses local weekday within seven days and date beyond", () => {
  const now = Date.parse("2026-10-29T10:00:00+07:00") / 1000;
  expect(resetCaption(Date.parse("2026-10-30T12:00:00+07:00") / 1000, now)).toBe("Fri 12:00");
  expect(resetCaption(Date.parse("2026-10-29T12:00:00+07:00") / 1000, now)).toBe("Thu 12:00");
  expect(resetCaption(now + 7 * 86400, now)).toBe("5 Nov 10:00");
});

test("login item IPC reads and writes native state and propagates failures", async () => {
  const calls: unknown[] = [];
  const native = createTrayIpc({ __TAURI__: { core: { invoke: async (command, args) => { calls.push([command, args]); return args?.enabled ?? true; } } }, location: { assign() {} } });
  expect(await native.loginItem()).toBe(true);
  expect(await native.loginItem(false)).toBe(false);
  expect(calls).toEqual([["tray_login_item", {}], ["tray_login_item", { enabled: false }]]);
  await expect(ipc.loginItem()).rejects.toThrow("desktop");
  const broken = createTrayIpc({ __TAURI__: { invoke: async () => { throw Error("Denied"); } }, location: { assign() {} } });
  await expect(broken.loginItem(true)).rejects.toThrow("Denied");
  const source = await Bun.file("desktop/src-tauri/src/main.rs").text();
  expect(source).toMatch(/fn tray_login_item[\s\S]*?authorized_tray\(&window, &app\)\?/);
  expect(source).toContain('.permission("allow-tray-login-item")');
  expect(source).toContain("launch_at_login(&app, enabled)?");
  expect(source).toContain("approvals::launch_at_login_enabled()");
});

test("off executor tooltip states why each agent cannot take work", () => {
  const row = fixture().executors![0]!;
  const html = draw({ ...fixture(), executors: [
    { ...row, id: "opencode#byteplus", agent: "opencode", account: "byteplus", eligibility: undefined, state: "down", reason: "no active subscription" },
    { ...row, id: "cursor", agent: "cursor", account: "cursor", enabled: false, sub: "Eligible" },
  ] }).split('aria-label="Executors"')[1]!.split("</section>")[0]!;
  expect(html).toContain("BytePlus: no active subscription");
  expect(html).toContain("Cursor: turned off");
  expect(html).not.toContain("Eligible");
  expect(html).toContain("pc-agent-mark--byteplus");
});

test("browser tray Answer opens the Needs you question panel", async () => {
  const routes: string[] = [];
  await performAction({ label: "Answer", op: "task.answer", params: { id: "task-1" } }, api, { ...ipc, desktop: false, open: async route => { routes.push(route); } });
  expect(routes).toEqual(["/needs-you?answer=task-1"]);
});

test("a failed row action's message clears when its attention item disappears", async () => {
  const { visibleFailure } = await import("../app/src/tray/model");
  const failure = { message: "pacer could not open that. Try again, or open pacer to finish there.", item: "message:t-1" };
  expect(visibleFailure(failure, [{ id: "message:t-1" }, { id: "review:t-2" }])).toBe(failure.message);
  expect(visibleFailure(failure, [{ id: "review:t-2" }])).toBe("");
  expect(visibleFailure(failure, undefined)).toBe("");
  expect(visibleFailure({ message: "Hide failed" }, [])).toBe("Hide failed");
  expect(visibleFailure(null, [{ id: "message:t-1" }])).toBe("");
});
