import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { UsageState, Verdict } from "../src/types";
import { usageStateFor, withUsageState } from "./usage-fixtures";
import type { Route } from "../app/src/router";
import { createKeyRegistry } from "../app/src/keys/registry";
import { StatusBar, UsageDetails, dismissUsageOnEscape } from "../app/src/shell/StatusBar";

const snapshot = fixture as unknown as ClientSnapshot;
const route = (name: Route["name"], id?: string): Route => ({ name, ...(id ? { id } : {}), query: { repo: null, scope: null } }) as Route;
const registry = createKeyRegistry({ controlActive: () => false });
registry.register({ keys: "d", label: "Delegate a task", scope: "global", run: () => {} });
registry.register({ keys: "?", label: "Show keyboard shortcuts", scope: "global", run: () => {} });
registry.register({ keys: "j", label: "select", scope: "dispatch", run: () => {} });
registry.register({ keys: "k", label: "select", scope: "dispatch", run: () => {} });
registry.register({ keys: "s", label: "Stop session", scope: "sessions", run: () => {} });

test("the whole usage summary opens details and keeps only vendor marks and percentages", () => {
  const html = renderToString(<StatusBar route={route("review")} snapshot={withUsageState(snapshot)} registry={registry} />);
  expect(html).toContain("pc-statusbar");
  const usage = html.match(/<button[^>]*aria-label="Usage details[^"]*"[^>]*>(.*?)<\/button>/)?.[1] ?? "";
  expect(usage).toContain("63%");
  expect(usage).toContain("3%");
  expect(usage).toContain("0%");
  expect(usage).toContain("pc-agent-mark");
  expect(usage).toContain("pc-meter--mini");
  expect(usage).not.toContain("Historical usage");
  expect(usage).not.toContain("Planner");
  // The frame shows one shortcut pointer, the work counts and the version; per-screen keys live in the help dialog.
  expect(html).toContain("? shortcuts");
  expect(html).toMatch(/\d+ running · \d+ queued/);
  expect(html).not.toContain("select");
  expect(html).not.toContain("as of");
});

test("on Dispatch the planner keeps only its mark, because the Planner budget states the figure", () => {
  const html = renderToString(<StatusBar route={route("dispatch")} snapshot={withUsageState(snapshot)} registry={registry} />);
  const usage = html.match(/<button[^>]*aria-label="Usage details[^"]*"[^>]*>(.*?)<\/button>/)?.[1] ?? "";
  expect(usage).not.toContain("63%");
  expect(usage).toContain("3%");
  expect(html).toContain("Claude Code planner, shown in Planner budget");
  expect(html).not.toMatch(/aria-label="Usage details[^"]*63%/);
});

test("stale planner usage visibly marks freshness and names it for assistive technology", () => {
  const historical = withUsageState({ ...snapshot, planner: { ...snapshot.planner!, stale: true } });
  const html = renderToString(<StatusBar route={route("review")} snapshot={historical} registry={registry} />);
  expect(html).toContain("historical usage");
  expect(html).toContain('role="img" aria-label="Historical usage" class="pc-statusbar__stale">!</span>');
  // The chip shows the "!" mark, not the words; the words are its accessible name.
  expect(html).not.toContain(">Historical usage<");
  expect(html).not.toContain("behind pace");
});

test("a planner that is ahead of pace is flagged in words, not only colour", () => {
  const ahead = withUsageState({ ...snapshot, planner: { ...snapshot.planner!, verdict: "ahead" as const } });
  const html = renderToString(<StatusBar route={route("review")} snapshot={ahead} registry={registry} />);
  expect(html).toContain('aria-label="Ahead of pace" class="pc-statusbar__stale">!</span>');
  expect(html).toContain("ahead of pace");
});

test("usage details list every quota window and distinguish stale and unknown readings", () => {
  const now = snapshot.at;
  const personal = usageStateFor({ usedPct: 47, window: "weekly", resetsAt: now + 86400, stale: false, source: "status-line" }, now);
  const windows: UsageState["windows"] = [
    { name: "5h", usedPct: 9, resetsAt: now + 3600, lengthS: 18000, paced: false, stale: false, verdict: "ON_PACE" },
    ...(personal.windows),
  ];
  const html = renderToString(<UsageDetails accounts={[
    { name: "personal", kind: "claude", usageState: { ...personal, windows } },
    { name: "work", kind: "codex", usageState: { ...usageStateFor({ usedPct: null, window: "weekly", stale: true, source: "session-log", capturedAt: now - 26 * 3600 }, now), windows: [{ name: "weekly", usedPct: null, resetsAt: null, lengthS: 604800, paced: false, stale: true, verdict: "UNKNOWN" }], error: { message: "Refresh failed", at: now } } },
  ]} now={now} />);
  expect(html).toContain("personal");
  expect(html).toContain("5 h");
  expect(html).toContain("9%");
  expect(html).toContain("week");
  expect(html).toContain("47%");
  expect(html).toContain("resets");
  expect(html).toContain("Reading 26h old · refresh");
  expect(html).toContain("Reading failed");
  expect(html).not.toContain("session-log");
  expect(html).toContain("Session logs");
  expect(html).toContain("Usage unknown");
});

test("usage details do not call a measured window unavailable just because observation time is missing", () => {
  const html = renderToString(<UsageDetails accounts={[{ name: "team", kind: "codex", usageState: usageStateFor({ usedPct: 28, window: "weekly", resetsAt: null, capturedAt: null }, snapshot.at) }]} now={snapshot.at} />);
  expect(html).toContain("28%");
  expect(html).not.toContain("Usage unavailable");
});

test("a limit window keeps Out of quota in the words column and leaves the number column empty", () => {
  const now = snapshot.at;
  const limited = usageStateFor({ usedPct: 100, window: "limit", resetsAt: now + 3600, verdict: "out" }, now);
  const state: UsageState = {
    ...limited,
    limit: { until: now + 3600, observedAt: now, manual: false },
    verdict: "EXHAUSTED",
    windows: [{ name: "limit", usedPct: 100, resetsAt: now + 3600, lengthS: 21600, paced: false, stale: false, verdict: "EXHAUSTED" }],
  };
  const html = renderToString(<UsageDetails accounts={[{ name: "personal", kind: "claude", usageState: state }]} now={now} />);
  // The limit row's number column stays empty; "Out of quota" appears once in that row's words.
  const row = html.match(/<div class="pc-usage-window">[\s\S]*?<\/div>/)?.[0] ?? "";
  expect(row).toMatch(/<span class="pc-num"><\/span>/);
  expect(row.match(/Out of quota/g)?.length).toBe(1);
  expect(row).not.toMatch(/<span class="pc-num">Out of quota<\/span>/);
});

test("Escape closes usage details before a route shortcut receives it", () => {
  let closed = false, prevented = false, stopped = false;
  dismissUsageOnEscape({ key: "Escape", preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } }, () => { closed = true; });
  expect([closed, prevented, stopped]).toEqual([true, true, true]);
});

test("shortcut registry notifies the status bar when screens mount and unmount", () => {
  let updates = 0;
  const stopListening = registry.subscribe(() => updates++);
  const unregister = registry.register({ keys: "x", label: "dismiss", scope: "dispatch", run: () => {} });
  unregister();
  stopListening();
  expect(updates).toBe(2);
});


test("Dispatch keeps the planner mark without a figure when its main reading is missing", () => {
  const historical = withUsageState({ ...snapshot, planner: { ...snapshot.planner!, runner: "codex#team", agent: "codex", usedPct: null, stale: true },
    executors: [{ ...snapshot.executors![0]!, id: "codex#team", account: "team", usedPct: 28, stale: true }] });
  const html = renderToString(<StatusBar route={route("dispatch")} snapshot={historical} registry={registry} />);
  const usage = html.match(/<button[^>]*aria-label="Usage details[^"]*"[^>]*>.*?<\/button>/)?.[0] ?? "";
  expect(usage).toContain("pc-agent-mark");
  expect(usage).toContain("Codex planner, shown in Planner budget");
  expect(usage).not.toContain("28%");
  expect(usage).not.toContain("pc-meter");
  const elsewhere = renderToString(<StatusBar route={route("review")} snapshot={historical} registry={registry} />);
  expect(elsewhere).toContain("Codex · team 28%, historical usage");
  expect(elsewhere).toContain("pc-meter--mini");
});

test('hidden control labels pluralize and release requires a counted confirmation', async () => {
  const {hiddenControlLabel,handBackHidden}=await import('../app/src/shell/StatusBar');
  expect(hiddenControlLabel(1)).toBe('In control of 1 hidden session · Hand back');
  expect(hiddenControlLabel(2)).toBe('In control of 2 hidden sessions · Hand back');
  let releases=0,message='';const sessions=[{release:()=>releases++},{release:()=>releases++}];
  await handBackHidden(sessions,async text=>{message=text;return false;});
  expect(message).toContain('2 hidden sessions');expect(releases).toBe(0);
  await handBackHidden(sessions,async()=>true);expect(releases).toBe(2);
});

test('hidden control action uses its visible text as its accessible name in a polite region',async()=>{
  const {sessionRuntimes}=await import('../app/src/term/runtime');
  const runtime=sessionRuntimes.get('test-statusbar','terminal:shell',{url:'ws://localhost/session',cols:80,rows:24,label:'shell',control:true});
  runtime.intent='driving';runtime.state={...runtime.state,you:true};
  try{const html=renderToString(<StatusBar snapshot={snapshot} registry={registry}/>);
    const action=html.match(/<button[^>]*>[^]*?In control of 1 hidden session · Hand back<\/button>/)?.[0]??'';
    expect(action).toContain('In control of 1 hidden session · Hand back');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).not.toContain('aria-label="Hand back control');
  }finally{sessionRuntimes.dispose();}
});

test("near-limit and out-of-quota chips are spoken in the usage button's name, not shown by colour alone", () => {
  const withVerdict = (verdict: Verdict) => {
    const s = withUsageState(snapshot);
    return { ...s, planner: { ...s.planner!, usageState: { ...s.planner!.usageState!, verdict } } };
  };
  const nearHtml = renderToString(<StatusBar route={route("review")} snapshot={withVerdict("NEAR_LIMIT")} registry={registry} />);
  expect(nearHtml).toMatch(/aria-label="Usage details: [^"]*63%, near limit/);
  expect(nearHtml).toContain('role="img" aria-label="Near limit" class="pc-statusbar__stale">!</span>');
  const outHtml = renderToString(<StatusBar route={route("review")} snapshot={withVerdict("EXHAUSTED")} registry={registry} />);
  expect(outHtml).toMatch(/aria-label="Usage details: [^"]*63%, out of quota/);
  expect(outHtml).toContain('role="img" aria-label="Out of quota" class="pc-statusbar__stale">!</span>');
});
