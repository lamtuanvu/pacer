import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
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
  const html = renderToString(<StatusBar route={route("review")} snapshot={snapshot} registry={registry} />);
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
  const html = renderToString(<StatusBar route={route("dispatch")} snapshot={snapshot} registry={registry} />);
  const usage = html.match(/<button[^>]*aria-label="Usage details[^"]*"[^>]*>(.*?)<\/button>/)?.[1] ?? "";
  expect(usage).not.toContain("63%");
  expect(usage).toContain("3%");
  expect(html).toContain("Claude Code planner, shown in Planner budget");
  expect(html).not.toMatch(/aria-label="Usage details[^"]*63%/);
});

test("stale planner usage visibly marks freshness and names it for assistive technology", () => {
  const historical = { ...snapshot, planner: { ...snapshot.planner!, stale: true } };
  const html = renderToString(<StatusBar route={route("review")} snapshot={historical} registry={registry} />);
  expect(html).toContain("historical usage");
  expect(html).toContain('role="img" aria-label="Stale reading" class="pc-statusbar__stale">!</span>');
  expect(html).not.toContain("Historical usage");
  expect(html).not.toContain("behind pace");
});

test("a planner that is ahead of pace is flagged in words, not only colour", () => {
  const ahead = { ...snapshot, planner: { ...snapshot.planner!, verdict: "ahead" as const } };
  const html = renderToString(<StatusBar route={route("review")} snapshot={ahead} registry={registry} />);
  expect(html).toContain('aria-label="Ahead of pace" class="pc-statusbar__stale">!</span>');
  expect(html).toContain("ahead of pace");
});

test("usage details list every quota window and distinguish stale and unknown readings", () => {
  const html = renderToString(<UsageDetails accounts={[
    { name: "personal", kind: "claude", usageReading: { windows: [
      { name: "5h", usedPct: 9, resetsAt: snapshot.at + 3600 },
      { name: "weekly", usedPct: 47, resetsAt: snapshot.at + 86400 },
    ], capturedAt: snapshot.at - 120, stale: false, source: "status-line" } },
    { name: "work", kind: "codex", usageReading: { windows: [{ name: "weekly", usedPct: null, resetsAt: null }], capturedAt: snapshot.at - 86400, stale: true, source: "session-log", error: "Refresh failed" } },
  ]} now={snapshot.at} />);
  expect(html).toContain("personal");
  expect(html).toContain("5h");
  expect(html).toContain("9%");
  expect(html).toContain("weekly");
  expect(html).toContain("47%");
  expect(html).toContain("resets");
  expect(html).toContain("Historical usage");
  expect(html).toContain("Reading failed");
  expect(html).not.toContain("session-log");
  expect(html).toContain("Session logs");
  expect(html).toContain("Usage unknown");
});

test("usage details do not call a measured window unavailable just because capture time is missing", () => {
  const html = renderToString(<UsageDetails accounts={[{ name: "team", kind: "codex", usageReading: { windows: [{ name: "weekly", usedPct: 28, resetsAt: null }], capturedAt: null, stale: false } }]} now={snapshot.at} />);
  expect(html).toContain("Reading time unknown");
  expect(html).not.toContain("Usage unavailable");
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
