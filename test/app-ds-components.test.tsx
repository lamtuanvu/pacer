import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { clock } from "../src/view-model/format";
import { UsageMeter } from "../app/src/ds/UsageMeter";
import { StatusGlyph } from "../app/src/ds/StatusGlyph";
import { Tooltip } from "../app/src/ds/Tooltip";
import { Kbd } from "../app/src/ds/Kbd";

test("meter exposes value text in words", () => {
  const html = renderToString(<UsageMeter used={63} pace={77} tone="good" verdict="behind" size="top" label="Planner" text="compact" />);
  expect(html).toContain('role="meter"');
  expect(html).toContain('aria-valuenow="63"');
  expect(html).toContain('aria-valuetext="63% used, pace 77%, behind pace"');
  expect(html).toContain('aria-label="Planner"');
  expect(html).toContain(">63%·77<");
  expect(html).toContain("pc-meter--top");
  expect(html).toContain("pc-meter__pace");
});

test("full text by default", () => {
  expect(renderToString(<UsageMeter used={63} pace={77} tone="good" size="bar" label="Codex" />)).toContain(">63% used · pace 77%<");
  expect(renderToString(<UsageMeter used={63} pace={77} tone="good" size="row" label="Codex" text="none" />)).not.toContain("pace 77%<");
});

test("meter without pace has no tick and says why", () => {
  const html = renderToString(<UsageMeter used={20} pace={null} paceReason="unmetered" tone="good" size="row" label="Local" />);
  expect(html).not.toContain("pc-meter__pace");
  expect(html).toContain("20% used · unmetered");
  expect(html).toContain('aria-valuetext="20% used, unmetered"');
});

test("meter uses the tone it is given", () => {
  const html = renderToString(<UsageMeter used={99} pace={10} tone="good" size="row" label="x" />);
  expect(html).toContain("pc-meter__fill--good");
  expect(html).not.toContain("pc-meter__fill--bad");
});

test("unknown usage draws no fill", () => {
  const html = renderToString(<UsageMeter used={null} pace={null} tone="neutral" size="row" label="x" />);
  expect(html).toContain('aria-label="x: usage unknown"');
  expect(html).not.toContain("aria-valuenow");
  expect(html).not.toContain("pc-meter__fill");
});

test("stale meter is dimmed and says when it was read", () => {
  const staleAt = Date.UTC(2026, 9, 16, 4, 40) / 1000; // 11:40 in the test time zone
  const html = renderToString(<UsageMeter used={50} pace={40} tone="warn" size="top" label="x" stale staleAt={staleAt} now={staleAt + 600} />);
  expect(html).toContain("pc-meter--stale");
  expect(html).toContain(`as of ${clock(staleAt, staleAt + 600)}`);
});

test("fill width is a custom property, not a colour", () => {
  const html = renderToString(<UsageMeter used={140} pace={77} tone="good" size="row" label="x" />);
  expect(html).toContain("--used:100");
  expect(html).not.toMatch(/style="[^"]*(color|background)/);
});

test("glyphs are hidden from assistive tech", () => {
  expect(renderToString(<StatusGlyph kind="failed" />)).toBe('<span class="pc-glyph pc-glyph--failed" aria-hidden="true">✕</span>');
  expect(renderToString(<StatusGlyph kind="waiting" />)).toContain("◐");
  expect(renderToString(<StatusGlyph kind="done" />)).toContain("✓");
});

test("tooltip is referenced by its trigger and starts hidden", () => {
  const html = renderToString(<Tooltip text="Overview · 3 need you"><button type="button">O</button></Tooltip>);
  const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  expect(describedBy).toBeDefined();
  expect(html).toContain(`id="${describedBy}"`);
  expect(html).toContain('role="tooltip"');
  expect(html).toMatch(/role="tooltip"[^>]*hidden|hidden[^>]*role="tooltip"/);
});

test("kbd renders a key", () => {
  expect(renderToString(<Kbd>g o</Kbd>)).toBe('<kbd class="pc-kbd">g o</kbd>');
});

test("an unknown meter is an image with words, not a meter without a value", () => {
  const html = renderToString(<UsageMeter used={null} pace={null} tone="neutral" size="row" label="Codex" />);
  expect(html).not.toContain('role="meter"');
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="Codex: usage unknown"');
});
