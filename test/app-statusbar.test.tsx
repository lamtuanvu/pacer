import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { Route } from "../app/src/router";
import { createKeyRegistry } from "../app/src/keys/registry";
import { StatusBar, UsageDetails, dismissUsageOnEscape, screenHints } from "../app/src/shell/StatusBar";

const snapshot = fixture as unknown as ClientSnapshot;
const route = (name: Route["name"], id?: string): Route => ({ name, ...(id ? { id } : {}), query: { repo: null, scope: null } }) as Route;
const registry = createKeyRegistry({ controlActive: () => false });
registry.register({ keys: "d", label: "Delegate a task", scope: "global", run: () => {} });
registry.register({ keys: "?", label: "Show keyboard shortcuts", scope: "global", run: () => {} });
registry.register({ keys: "j", label: "select", scope: "overview", run: () => {} });
registry.register({ keys: "k", label: "select", scope: "overview", run: () => {} });
registry.register({ keys: "s", label: "Stop session", scope: "sessions", run: () => {} });

test("the whole usage summary opens details and keeps only vendor marks and percentages", () => {
  const html = renderToString(<StatusBar route={route("overview")} snapshot={snapshot} registry={registry} />);
  expect(html).toContain("pc-statusbar");
  const usage = html.match(/<button[^>]*aria-label="Usage details[^"]*"[^>]*>(.*?)<\/button>/)?.[1] ?? "";
  expect(usage).toContain("63%");
  expect(usage).toContain("3%");
  expect(usage).toContain("0%");
  expect(usage).toContain("pc-agent-mark");
  expect(usage).not.toContain("pc-meter");
  expect(usage).not.toContain("Historical usage");
  expect(usage).not.toContain("Planner");
  expect(html).toContain("j k");
  expect(html).toContain("select");
  expect(html).not.toContain("Stop session");
  expect(html).not.toContain("as of");
});

test("stale planner usage retains freshness in the accessible name without cluttering the footer", () => {
  const historical = { ...snapshot, planner: { ...snapshot.planner!, stale: true } };
  const html = renderToString(<StatusBar route={route("overview")} snapshot={historical} registry={registry} />);
  expect(html).toContain("historical usage");
  expect(html).not.toContain("Historical usage");
  expect(html).not.toContain("behind pace");
});

test("settings shortcut uses the compact Esc key label", () => {
  const settings = createKeyRegistry({ controlActive: () => false });
  settings.register({ keys: "Escape", label: "Close the settings panel", scope: "settings", run: () => {} });
  const html = renderToString(<StatusBar route={route("settings")} snapshot={snapshot} registry={settings} />);
  expect(html).toContain('class="pc-kbd">Esc</kbd>');
  expect(html).not.toContain('class="pc-kbd">Escape</kbd>');
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

test("shortcut hints follow the route and omit inactive shortcuts", () => {
  expect(screenHints(registry.list(), route("overview")).map(hint => hint.label)).toContain("select");
  expect(screenHints(registry.list(), route("sessions", "task-1")).map(hint => hint.label)).toContain("stop session");
  expect(screenHints(registry.list(), route("settings")).map(hint => hint.label)).not.toContain("stop session");
});

test("shortcut hints use compact labels and ranges in the bottom bar", () => {
  const shortcuts = [
    ...registry.list(),
    ...["1", "2", "3", "4"].map(keys => ({ keys, label: "repo filter", scope: "overview", run: () => {} })),
    { keys: "/", label: "Focus the repo filter", scope: "overview", run: () => {} },
  ];
  const hints = screenHints(shortcuts, route("overview"));
  expect(hints).toContainEqual({ keys: "1–4", label: "repo filter" });
  expect(hints).toContainEqual({ keys: "/", label: "focus filter" });
});

test("busy screens keep the help shortcut visible without overflowing the bar", () => {
  const shortcuts = [
    ...registry.list(),
    ...["/", "Enter", "v", "1", "2", "3", "4", "x"].map(keys => ({ keys, label: keys, scope: "overview", run: () => {} })),
  ];
  const hints = screenHints(shortcuts, route("overview"));
  expect(hints.length).toBeLessThanOrEqual(6);
  expect(hints.at(-1)).toEqual({ keys: "?", label: "shortcuts" });
});

test("shortcut registry notifies the status bar when screens mount and unmount", () => {
  let updates = 0;
  const stopListening = registry.subscribe(() => updates++);
  const unregister = registry.register({ keys: "x", label: "dismiss", scope: "overview", run: () => {} });
  unregister();
  stopListening();
  expect(updates).toBe(2);
});
