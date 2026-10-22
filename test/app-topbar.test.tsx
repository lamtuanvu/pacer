import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { TopBar } from "../app/src/shell/TopBar";

const snap = fixture as unknown as ClientSnapshot;
const planner = snap.planner!;
const base = { title: "Overview", planner, mode: "normal", connected: true, lastUpdate: snap.at - 8, now: snap.at, onDelegate: () => {} };

test("planner identity remains in the top bar while usage lives in the status bar", () => {
  const html = renderToString(<TopBar {...base} />);
  expect(html).toContain("<header");
  expect(html).not.toContain("pc-meter");
  expect(html).toContain('aria-hidden="true"'); // the mark next to the planner name
  expect(html).toContain("Claude");
});

test("narrow top bar keeps planner usage because it has no desktop status bar", () => {
  const html = renderToString(<TopBar {...base} narrow />);
  expect(html).toContain('aria-valuetext="63% used, pace 77%, behind pace"');
  expect(html).toContain(">63%·77<");
});

test("mode chip always shows, in words, warn only when not normal, with the hold time", () => {
  expect(renderToString(<TopBar {...base} />)).toContain(">Normal<");
  expect(renderToString(<TopBar {...base} />)).toContain("pc-pill--neutral");
  const relaxed = renderToString(<TopBar {...base} mode="relaxed" />);
  expect(relaxed).toContain(">Relaxed<");
  const held = renderToString(<TopBar {...base} mode="strict" planner={{ ...planner, modeHeldUntil: snap.at + 3600 }} />);
  expect(held).toContain("Strict · held until");
});

test("live dot says when it last updated, and Reconnecting while down", () => {
  expect(renderToString(<TopBar {...base} />)).toContain("updated 8s ago");
  const down = renderToString(<TopBar {...base} connected={false} />);
  expect(down).toContain("Reconnecting…");
  expect(down).toContain("pc-live-dot--off");
});

test("unknown and stale planners still show their name without duplicated usage", () => {
  const unknown = renderToString(<TopBar {...base} planner={{ ...planner, verdict: "unknown", usedPct: null, pacePct: null }} />);
  expect(unknown).not.toContain("pc-meter");
  expect(unknown).toContain("Claude");
  expect(renderToString(<TopBar {...base} planner={null} />)).not.toContain("pc-meter");
  expect(renderToString(<TopBar {...base} planner={{ ...planner, stale: true }} />)).not.toContain("pc-meter");
});

test("Delegate is the one primary button, secondary when the screen owns the primary", () => {
  const html = renderToString(<TopBar {...base} />);
  expect(html.match(/pc-btn--primary/g)?.length).toBe(1);
  expect(html).toContain(">Delegate<");
  expect(renderToString(<TopBar {...base} delegatePrimary={false} />)).not.toContain("pc-btn--primary");
});

test("the top bar shows the current time", () => {
  expect(renderToString(<TopBar {...base} />)).toMatch(/pc-clock[^>]*>\d{2}:\d{2}</);
});
