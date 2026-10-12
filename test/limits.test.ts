import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import type { ProviderStatus } from "../src/engine/rank";
import { detectLimit, exhaustUntil } from "../src/exec/limits";

const r = (code: number, stdout: string, stderr = "", timedOut = false) => ({ code, stdout, stderr, timedOut });
const cfg = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: { cooldown: "6h" } } }, "/x").providers.codex;

test("limit messages on a failed run are detected", () => {
  expect(detectLimit("codex", r(1, "", "Error: rate limit reached, try again later"))).toBe(true);
  expect(detectLimit("cursor", r(1, "You have hit your usage limit"))).toBe(true);
  expect(detectLimit("byteplus", r(2, "", "HTTP 429 Too Many Requests"))).toBe(true);
  expect(detectLimit("agy", r(1, "", "quota exceeded for this project"))).toBe(true);
  expect(detectLimit("codex", r(1, "", '{"rate_limit_reached_type":"primary"}'))).toBe(true);
});

test("successful runs, timeouts and unrelated failures are not limits", () => {
  expect(detectLimit("codex", r(0, "Implemented the rate limit middleware"))).toBe(false);
  expect(detectLimit("codex", r(137, "", "rate limit", true))).toBe(false);
  expect(detectLimit("codex", r(1, "", "TypeError: x is undefined"))).toBe(false);
});

test("exhaustUntil uses the earliest future reset of a near-full window, else the cooldown", () => {
  const now = 1000;
  const st = (windows: { usedPct: number; resetsAt: number | null }[]) =>
    ({ windows: windows.map((w) => ({ name: "w", lengthS: 1, paced: true, verdict: "OK", ...w })) }) as unknown as ProviderStatus;
  expect(exhaustUntil(st([{ usedPct: 100, resetsAt: 5000 }, { usedPct: 95, resetsAt: 3000 }]), cfg, now)).toBe(3000);
  expect(exhaustUntil(st([{ usedPct: 40, resetsAt: 2000 }]), cfg, now)).toBe(now + 21600);
  expect(exhaustUntil(st([{ usedPct: 100, resetsAt: 500 }]), cfg, now)).toBe(now + 21600);
  expect(exhaustUntil(undefined, cfg, now)).toBe(now + 21600);
});

 for(const [provider,text] of [["cursor","ActionRequiredError: You've hit your usage limit"],["codex","You've hit your usage limit. Try again later."],["agy","quota exceeded for this project"]]) test(`recorded ${provider} quota text is a limit`,()=>{
 expect(detectLimit(provider!,r(1,"",text))).toBe(true);
 });
