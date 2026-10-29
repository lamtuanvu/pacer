import { expect, spyOn, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { phaseWords, verdictWords } from "../src/view-model/words";
import { needsYou, running } from "../src/view-model/selectors";
import { DispatchHome } from "../app/src/screens/dispatch/Dispatch";
import { TaskContext } from "../app/src/screens/task-shared";
import { ActionContext } from "../app/src/data/action-context";
import { createActionRunner } from "../app/src/data/actions";
import { initialState, reduceStore } from "../app/src/data/store";
import { createApi } from "../app/src/data/api";
import { Tray } from "../app/src/tray/Tray";
import { createTrayIpc } from "../app/src/tray/ipc";
import { shortTitle } from "../app/src/tray/model";
import { renderDashboard } from "../src/dashboard/render";
import { renderLine } from "../src/render/line";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

/** Compare visible prose, never CSS, SVG paths, attributes or terminal styling. */
function strip(text: string): string {
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  // Scan characters instead of regex-replacing markup: drop tags and the contents of style, script and svg.
  let out = "", i = 0, skipUntil: string | null = null;
  while (i < plain.length) {
    if (plain[i] === "<") {
      const close = plain.indexOf(">", i);
      if (close < 0) break;
      const tag = plain.slice(i + 1, close).trim().toLowerCase();
      const name = tag.replace(/^\//, "").split(/[\s/]/)[0]!;
      if (skipUntil) { if (tag.startsWith("/") && name === skipUntil) skipUntil = null; }
      else if (["style", "script", "svg"].includes(name) && !tag.startsWith("/") && !tag.endsWith("/")) skipUntil = name;
      out += " "; i = close + 1; continue;
    }
    if (!skipUntil) out += plain[i];
    i++;
  }
  // Decoding never produces < or >, so markup cannot be reintroduced.
  return out
    .replace(/&#(x[\da-f]+|\d+);/gi, (m, n: string) => { const c = n[0] === "x" ? parseInt(n.slice(1), 16) : Number(n); return c === 60 || c === 62 ? m : String.fromCodePoint(c); })
    .replace(/&(amp|quot|apos|#39|nbsp);/g, (_, n: string) => ({ amp: "&", quot: '"', apos: "'", "#39": "'", nbsp: " " })[n]!)
    .replace(/\s+/g, " ").trim();
}
const snapshot = structuredClone(fixture) as unknown as ClientSnapshot;
const api = createApi();
const state = reduceStore(initialState(), { type: "snapshot", snapshot });
const runner = createActionRunner({ call: async <T,>() => ({} as T), waitFor: async () => true, refetch() {}, navigate() {} });
const frozenNow = spyOn(Date, "now").mockReturnValue(snapshot.at * 1000);
let app: string;
try { app = renderToString(<TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={runner}><DispatchHome query={{ repo: null, scope: null }} /></ActionContext.Provider></TaskContext.Provider>); } finally { frozenNow.mockRestore(); }
const tray = renderToString(<Tray snapshot={snapshot} api={api} ipc={createTrayIpc({ location: { assign() {} } })} />);
const tui = renderDashboard(snapshot, 120, 50, snapshot.at, { selected: 0, noColor: true, version: "0.3.0" });
const line120 = renderLine(snapshot, { width: 120, color: false });
const line20 = renderLine(snapshot, { width: 20, color: false });
const surfaces = { app, tray, tui };

for (const [name, output] of Object.entries({ app, tray, tui, line120, line20 })) {
  test(`golden ${name}`, () => expect(name === "tui" ? output.split("\n").map(line => line.trimEnd()).join("\n") : output).toMatchSnapshot());
}

test("golden --line --json fields use the fixture through the local link", async () => {
  const ctx = fakeCtx({ now: snapshot.at, env: { PACER_PORT: "1" } });
  mkdirSync(join(ctx.pacerHome, "link"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "link/latest.json"), JSON.stringify(snapshot));
  const result = await main(["status", "--line", "--json"], ctx);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  const fields = JSON.parse(result.out);
  expect(fields).toMatchSnapshot();
  expect(fields).toMatchObject({ online: true, running: snapshot.counts!.running, attention: snapshot.counts!.attention, verdict: snapshot.planner!.verdict, usedPct: snapshot.planner!.usedPct, pacePct: snapshot.planner!.pacePct });
});

test("cross-surface counts use service totals and repo totals", () => {
  const c = snapshot.counts!, today = snapshot.today!;
  const text = Object.fromEntries(Object.entries(surfaces).map(([name, html]) => [name, strip(html).toLowerCase()]));
  expect(text.app).toContain(`needs you ${c.attention} `);
  expect(text.app).toContain(`live dispatch ${c.running} running ${c.queued} queued`);
  // The app's period figures come from insights.summary, not the snapshot's daily counts; without it the strip says so.
  expect(text.app).toContain("these figures need a newer pacer service with task insights.");
  expect(text.tray).toContain(`${c.attention} needs you ${c.running} running ${c.queued} waiting ${today.done} done today`);
  expect(text.tui).toContain(`needs you ${c.attention}`);
  expect(text.tui).toContain(`running ${c.running} · ${c.queued} queued`);
  expect(text.tui).toContain(`done today ${today.done}`);
  expect(line120).toContain(`▸${c.running}`);
  for (const line of [line120, line20]) { expect(line).toContain(`⚑${c.attention}`); expect(line).not.toContain("\x1b"); }
  expect(line120.length).toBeLessThanOrEqual(120); expect(line20.length).toBeLessThanOrEqual(20);
});

test("cross-surface vocabulary uses shared verdicts, phases and acceptance words", () => {
  for (const [name, output] of Object.entries(surfaces)) {
    const text = strip(output);
    // Only the tray and TUI boards print a planner verdict beside the meter.
    if (name === "tray" || name === "tui") expect(text).toContain(verdictWords(snapshot.planner!.verdict));
    const tasks = running(snapshot, { repo: null });
    for (const task of tasks.filter(task => task.state === "running" && task.progress)) {
      const phase = phaseWords(task.progress!.phase);
      expect(text).toContain(phase);
    }
    // Every surface states the acceptance outcome in the same words.
    expect(text).toContain("Tests passed");
    expect(text).not.toMatch(/\b(?:ON_PACE|BEHIND|AHEAD|EXHAUSTED|NEAR_LIMIT|EXPIRING_SOON|UNMETERED|needs_input|on_pace|host_down|executor_down|no_slot|working|testing|lost-contact)\b/);
  }
  // Compact lines intentionally omit behind/on-pace verdict text and phases.
  for (const line of [line120, line20]) expect(strip(line)).not.toMatch(/\b(?:ON_PACE|BEHIND|needs_input|on_pace)\b/);
  const advice = snapshot.planner!.advice;
  expect(app).toContain(`class="pc-dispatch-advice">${advice}</p>`);
});

const headings = (output: string) => [...output.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map(match => strip(match[1]!));

test("the TUI order is Needs you, Running, Capacity, Done today", () => {
  for (const [name, output] of Object.entries({ tui })) {
    // Ignore summary counters: compare section headings, with the TUI's capacity label.
    const labels = name === "tui" ? output.split("\n").map(line => line.trim()).filter(line => /^(NEEDS YOU|RUNNING|CAPACITY|DONE TODAY)\b/.test(line)).join(" ")
      : headings(output).join(" ");
    const words = ["needs you", "running", "capacity", "done today"];
    const positions = words.map(word => labels.toLowerCase().indexOf(word));
    expect(positions.every(at => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  }
});

test("app follows the board on desktop: planner budget, the week's figures, Needs you, then live work", () => {
  const at = ["<h1>Dispatch</h1>", 'aria-label="Planner budget and next decision"', 'aria-label="This week at a glance"', 'aria-labelledby="needs-you"', 'aria-labelledby="live-dispatch"'].map(marker => app.indexOf(marker));
  expect(at.every(i => i >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  // No token reading yet: Where the tokens went is not rendered, and the glance strip invents no token figure.
  expect(app).not.toContain('aria-labelledby="token-share"');
  expect(strip(app.slice(app.indexOf('id="glance"'), app.indexOf('aria-labelledby="needs-you"')))).not.toMatch(/tokens/i);
});

test("tray orders Needs you, Running, executors with done today only in counts", () => {
  expect(headings(tray)).toEqual(["Needs you", "Running"]);
  const positions = ['aria-label="Needs you"', 'aria-label="Running"', 'aria-label="Executors"'].map(marker => tray.indexOf(marker));
  expect(positions.every(at => at >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  const counts = tray.split(/<nav(?=[^>]*aria-label="Task counts")[^>]*>/)[1]!.split("</nav>")[0]!;
  expect(strip(counts)).toContain(`${snapshot.today!.done} done today`);
  expect(strip(tray).match(/done today/g)).toHaveLength(1);
});

test("cross-surface Needs-you short titles preserve service order", () => {
  for (const [name, output] of Object.entries(surfaces)) {
    const items = needsYou(snapshot, { repo: null }).slice(0, name === "tray" ? 3 : undefined);
    const attention = name === "tui" ? output.split("NEEDS YOU")[1]!.split("RUNNING")[0]! : output.slice(output.indexOf(name === "app" ? 'aria-labelledby="needs-you"' : 'aria-label="Needs you"')).split("</section>")[0]!;
    const text = strip(attention), positions = items.map(item => text.indexOf(shortTitle(item)));
    expect(positions.every(at => at >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  }
});

function anchorRows(output: string, className: string): string[] {
  return [...output.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map(match => match[0]).filter(row => {
    const classes = row.match(/^<a\b[^>]*class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    return classes.includes(className);
  });
}

// Capacity left the home with the Dispatch merge (it lives in Settings › Executors); the tray keeps its compact rows.
test("tray shows unknown and unavailable capacity from the same rows", () => {
  const unknown = snapshot.executors!.find(row => row.state === "ready" && row.usedPct === null)!;
  expect(unknown.paceReason).toBe("no limit reported");
  const trayRow = anchorRows(tray, 'tray-executor').find(row => row.includes(` · ${unknown.slots.used}/${unknown.slots.max} parallel tasks`) && row.includes("Usage unknown"));
  expect(trayRow).toContain("tray-executor-value--muted");
  expect(trayRow).toContain(">?</span>");

  const unavailable = { ...unknown, state: "down" as const, tone: "bad" as const, reason: "no active coding-plan subscription", sub: "Unavailable" };
  const unavailableSnapshot = { ...snapshot, executors: [unavailable] };
  const popover = renderToString(<Tray snapshot={unavailableSnapshot} api={api} ipc={createTrayIpc({ location: { assign() {} } })} />);
  expect(anchorRows(popover, 'tray-executor--off')).toHaveLength(1);
  expect(popover).toContain(">off</span>");
  expect(popover).not.toContain(">free</span>");
});

test("tray and redesigned TUI preserve uncertain historical eligibility", () => {
  const executor = {
    ...snapshot.executors![1]!, state: "ready" as const, usedPct: 100, stale: true,
    eligibility: {
      state: "uncertain" as const, reasons: [{ code: "budget_expired_or_unknown", evidenceIds: [] }],
      evaluatedAt: snapshot.at, validUntil: null, evidenceAgeS: 3600,
      availability: "ready" as const, budget: "unknown" as const, spendingRisk: "unknown" as const,
    },
  };
  const s = { ...snapshot, tasks: [], attention: [], executors: [executor] };
  const popover = renderToString(<Tray snapshot={s} api={api} ipc={createTrayIpc({ location: { assign() {} } })} />);
  const terminal = renderDashboard(s, 120, 40, s.at, { noColor: true });
  // Tray puts the complete compact-row explanation in its accessible label.
  for (const output of [popover, strip(terminal)]) {
    expect(output).toContain("Uncertain fallback");
    expect(output).toContain("Historical usage");
    expect(output).toContain("observed 1h ago");
    expect(output).toContain("Budget evidence has expired or is incomplete");
  }
});
