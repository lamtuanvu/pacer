import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "preact-render-to-string";
import { StackedShareBar } from "../app/src/ds/StackedShareBar";
import type { ShareSegment } from "../src/view-model/dispatch";

const segments: ShareSegment[] = [
  { id: "codex", label: "Codex", agent: "codex", share: 53, detail: "980k tokens · 4 tasks", series: 1 },
  { id: "claude-code", label: "Claude Code", agent: "claude-code", share: 47, detail: "520k tokens · 6 tasks", series: 2 },
  { id: "other", label: "Other agents", share: 0, detail: "1k tokens · 1 task", series: 3 },
];
const html = () => renderToString(<StackedShareBar label="Token share" segments={segments} />);

test("share_bar_is_one_image_named_in_words", () => {
  const out = html();
  expect(out.match(/role="img"/g)).toHaveLength(1);
  expect(out).toContain('aria-label="Token share: Codex 53%, Claude Code 47%, Other agents 0%"');
  // Segments are geometry inside the image; nothing in the bar is a separate target.
  expect(out).not.toMatch(/<rect[^>]*(tabindex|role|aria-label)/);
});

test("share_bar_states_every_share_in_text_not_colour_alone", () => {
  const out = html();
  expect(out).toContain('aria-label="Token share by agent"');
  for (const segment of segments) {
    expect(out).toContain(`>${segment.label}</span>`);
    expect(out).toContain(`>${segment.share}%</span>`);
    expect(out).toContain(`>${segment.detail}</span>`);
  }
  // Colour swatches and agent marks are decorative; the legend's words carry the meaning.
  const swatches = out.match(/<span[^>]*pc-share-bar__swatch[^>]*>/g) ?? [];
  expect(swatches).toHaveLength(3);
  for (const swatch of swatches) expect(swatch).toContain('aria-hidden="true"');
  // A zero share stays in the legend but draws no segment.
  expect(out.match(/<rect/g)).toHaveLength(2);
});

test("share_bar_renders_nothing_without_a_share", () => {
  expect(renderToString(<StackedShareBar label="Token share" segments={[]} />)).toBe("");
  expect(renderToString(<StackedShareBar label="Token share" segments={[{ ...segments[2]! }]} />)).toBe("");
});

test("share_bar_uses_only_chart_tokens_for_series_colour", () => {
  const css = readFileSync(join(import.meta.dir, "../app/src/ds/components.css"), "utf8");
  const rules = css.split("\n").filter(line => line.startsWith(".pc-share-bar__seg--"));
  expect(rules.join("")).toMatch(/\.pc-share-bar__seg--1\{fill:var\(--chart-1\);background:var\(--chart-1\)\}/);
  for (const n of [1, 2, 3, 4, 5]) expect(rules.join("")).toContain(`fill:var(--chart-${n})`);
  expect(rules.join("")).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
});
