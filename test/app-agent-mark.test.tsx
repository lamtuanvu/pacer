import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "preact-render-to-string";
import { AGENT_IDS, agentInfo } from "../src/view-model/agents";
import { AGENT_GLYPHS } from "../app/src/ds/agent-glyphs";
import { AgentMark } from "../app/src/ds/AgentMark";

test("every known agent has a name, a glyph with a licence, and a colour", () => {
  for (const id of AGENT_IDS) {
    const info = agentInfo(id);
    expect(info.name.length).toBeGreaterThan(0);
    expect(info.glyph).not.toBeNull();
    const glyph = AGENT_GLYPHS[info.glyph!];
    expect(glyph.path.length).toBeGreaterThan(10);
    expect(["CC0-1.0", "MIT"]).toContain(glyph.license);
    expect(info.color === "ink" || /^#[0-9A-F]{6}$/.test(info.color)).toBe(true);
  }
});

test("brand colours follow the spec", () => {
  expect(["claude-code", "agy", "byteplus", "gemini", "cursor", "local", "opencode"].map(id => agentInfo(id).color))
    .toEqual(["#D97757", "#4285F4", "#3C8CFF", "#8E75B2", "ink", "ink", "ink"]);
});

test("codex uses the OpenAI mark on a page tile with a hairline", () => {
  expect(agentInfo("codex")).toMatchObject({ name: "Codex", glyph: "openai", color: "ink", tile: "page-hairline" });
  expect(AGENT_GLYPHS.openai.source).toBe("lobe-icons");
});

test("unknown agents get a two-letter monogram on ink", () => {
  expect(agentInfo("zed")).toMatchObject({ name: "zed", glyph: null, color: "ink", monogram: "ZE" });
});

test("aliases resolve", () => {
  expect(agentInfo("claude").name).toBe("Claude");
  expect(agentInfo("antigravity").name).toBe("Antigravity");
  expect(agentInfo("local").name).toBe("Local model");
});

test("rendered mark is labelled or hidden", () => {
  const labelled = renderToString(<AgentMark agent="codex" />);
  expect(labelled).toContain('role="img"');
  expect(labelled).toContain('aria-label="Codex"');
  const hidden = renderToString(<AgentMark agent="codex" labelled={false} />);
  expect(hidden).toContain('aria-hidden="true"');
  expect(hidden).not.toContain("aria-label");
  expect(renderToString(<AgentMark agent="zed" />)).toContain(">ZE<");
});

test("marks carry no inline colours", () => {
  for (const agent of [...AGENT_IDS, "zed"]) {
    const html = renderToString(<AgentMark agent={agent} size={24} />);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(html).not.toMatch(/style="[^"]*color/);
  }
});

test("NOTICE credits Lobe Icons", () => {
  const notice = readFileSync(join(import.meta.dir, "../NOTICE"), "utf8");
  expect(notice).toContain("Lobe Icons");
  expect(notice).toContain("MIT");
});

test("brand colours in components.css match the agent table", () => {
  const css = readFileSync(join(import.meta.dir, "../app/src/ds/components.css"), "utf8");
  for (const id of AGENT_IDS) {
    const color = agentInfo(id).color;
    const rule = new RegExp(`\\.pc-agent-mark--${id} \\{ --agent-color: (#[0-9A-F]{6}); \\}`).exec(css);
    expect(rule?.[1] ?? "ink").toBe(color);
  }
});
