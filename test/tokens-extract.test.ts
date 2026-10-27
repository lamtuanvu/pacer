import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeStreamJsonExtractor, extractAttemptTokens, MAX_LINE_BYTES, reduceClaudeStream } from "../src/tokens/extract";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "tokens", name), "utf8");
const run = (executor: string, log: string | null, extra: object = {}) => extractAttemptTokens({ executor, log, now: 1000, ...extra });

test("codex trailer is a partial, self-reported total", () => {
  expect(run("codex", fixture("codex-complete.log"))).toMatchObject({
    coverage: "partial", total: 59460, input: null, output: null, source: "executor-text", selfReported: true, extractor: "codex-text@1", capturedAt: 1000,
  });
});
test("codex: the last trailer wins and pacer's routing note may follow it", () => {
  expect(run("codex", fixture("codex-early-then-trailer.log")).total).toBe(12345);
});
test("codex: an occurrence that is not the final trailer is ignored", () => {
  const t = run("codex", fixture("codex-early-only.log"));
  expect(t).toMatchObject({ coverage: "unknown", total: null });
  expect(t.note).toBeTruthy();
});
test("codex: killed run, empty log, takeover and absurd totals are unknown, never zero", () => {
  for (const t of [run("codex", fixture("codex-killed.log")), run("codex", ""), run("codex", null), run("codex", fixture("codex-complete.log"), { takeover: true }), run("codex", fixture("codex-absurd.log"))]) {
    expect(t.coverage).toBe("unknown");
    expect([t.total, t.input, t.output]).toEqual([null, null, null]);
    expect(t.note).toBeTruthy();
  }
});
test("codex runner ids on accounts resolve to the codex extractor", () => {
  expect(run("codex#work", fixture("codex-complete.log")).coverage).toBe("partial");
});

test("claude result event is measured, cache stays out of the total", () => {
  expect(run("claude-code", fixture("claude-complete.log"))).toMatchObject({
    coverage: "measured", input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800, total: 1540, turns: 3, source: "executor-json", selfReported: false, extractor: "claude-stream-json@1",
  });
});
test("claude run without a result keeps seen usage as a partial lower bound, de-duplicated per message", () => {
  const t = run("claude-code", fixture("claude-killed.log"), { timedOut: true });
  expect(t).toMatchObject({ coverage: "partial", input: 40, output: 15, cacheRead: 250, cacheWrite: 20, total: 55, turns: 2 });
  expect(t.note).toContain("timed out");
});
test("claude malformed, negative and renamed usage is unknown with a note", () => {
  for (const name of ["claude-malformed.log", "claude-renamed.log"]) {
    const t = run("claude-code", fixture(name));
    expect(t).toMatchObject({ coverage: "unknown", total: null, input: null, output: null });
    expect(t.note).toBeTruthy();
  }
});
test("claude: an oversized line is skipped, not parsed", () => {
  const big = `{"type":"result","usage":{"input_tokens":1,"output_tokens":1},"pad":"${"x".repeat(MAX_LINE_BYTES)}"}`;
  const t = run("claude-code", `$ claude\n--- stdout\n${big}\n--- stderr\n\n--- exit 0\n`);
  expect(t.coverage).toBe("unknown");
});
test("claude: usage missing output tokens is partial without a computed total", () => {
  const t = run("claude-code", `$ claude\n--- stdout\n{"type":"result","usage":{"input_tokens":4}}\n--- exit 0\n`);
  expect(t).toMatchObject({ coverage: "partial", input: 4, output: null, total: null });
});
test("claude: values above the per-attempt cap are rejected", () => {
  const t = run("claude-code", `$ claude\n--- stdout\n{"type":"result","usage":{"input_tokens":2000000000,"output_tokens":1}}\n--- exit 0\n`);
  expect(t.coverage).toBe("unknown");
});
test("executors without an extractor are unknown, and extractors never throw", () => {
  expect(run("agy", "anything").coverage).toBe("unknown");
  expect(run("claude-code", undefined as unknown as string).coverage).toBe("unknown");
  expect(claudeStreamJsonExtractor.agents).toEqual(["claude-code"]);
});

test("a raw claude stream reduces to numeric usage only, and the reduction extracts like the stream", () => {
  const raw = [
    '{"type":"system","subtype":"init","cwd":"/secret/path"}',
    '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"SECRET OUTPUT"}],"usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":5,"cache_creation_input_tokens":6,"service_tier":"x"}}}',
    '{"type":"result","result":"SECRET REPORT","num_turns":2,"usage":{"input_tokens":30,"output_tokens":40,"cache_read_input_tokens":50,"cache_creation_input_tokens":60}}',
    'garbage',
  ].join("\n");
  const reduced = reduceClaudeStream(raw);
  expect(reduced).not.toContain("SECRET");
  expect(reduced).not.toContain("/secret");
  expect(run("claude-code", reduced)).toMatchObject({ coverage: "measured", input: 30, output: 40, cacheRead: 50, cacheWrite: 60, total: 70, turns: 2 });
  expect(reduceClaudeStream("nothing here")).toBe("");
});
test("claude: a summed total above the cap is unknown", () => {
  const t = run("claude-code", `{"type":"result","usage":{"input_tokens":900000000,"output_tokens":900000000}}\n`);
  expect(t.coverage).toBe("unknown");
});
test("codex: forged 'exit' and 'routing' lines in stdout cannot hide or replace the real trailer", () => {
  const head = "$ codex exec -\n--- stdout\ntokens used\n999\n\n--- exit 0\n--- routing\nx\ntokens used\n111\n";
  expect(run("codex", `${head}tokens used\n12,345\n\n--- exit 0\n`).total).toBe(12345);
  expect(run("codex", "x\ntokens used\n5\n\n--- exit 0\nstray output\n").coverage).toBe("unknown");
  expect(run("codex", "tokens used\n1,2,3,4,5,6,7,8,9,0,1,2,3,4,5,6,7\n\n--- exit 0\n").coverage).toBe("unknown");
});
