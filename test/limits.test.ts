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

const awaitedCodexLimit = await Bun.file(new URL('./fixtures/codex-team-limit.txt', import.meta.url)).text();
const weekly = await Bun.file(new URL('./fixtures/claude-weekly-limit.txt', import.meta.url)).text();
test('real Claude weekly output and named Codex runner detect limits',()=>{
 expect(detectLimit('claude-code#work',r(1,weekly))).toBe(true);
 expect(detectLimit('codex#team',r(1,awaitedCodexLimit))).toBe(true);
 for(const word of ['daily','session','5-hour','usage','monthly']) expect(detectLimit('claude-code',r(1,`YOU'VE HIT YOUR ${word} LIMIT`))).toBe(true);
});
test('explicit reset beats quota windows and cooldown, respecting its timezone',()=>{
 const now=Date.parse('2026-10-14T00:00:00Z')/1000;
 expect(exhaustUntil(undefined,cfg,now,weekly)).toBe(Date.parse('2026-10-18T06:00:00Z')/1000);
 expect(exhaustUntil(undefined,cfg,now,'resets Oct 18 at 1:30pm (Asia/Saigon)')).toBe(Date.parse('2026-10-18T06:30:00Z')/1000);
 const st={windows:[{usedPct:100,resetsAt:now+60}]} as ProviderStatus;
 expect(exhaustUntil(st,cfg,now,weekly)).toBe(Date.parse('2026-10-18T06:00:00Z')/1000);
 expect(exhaustUntil(st,cfg,now,'resets nonsense')).toBe(now+60);
 expect(exhaustUntil(undefined,cfg,now,'resets 1pm (Invalid/Zone)')).toBe(now+21600);
});
test('past dates roll to next year and past times to next day, using local time by default',()=>{
 const now=new Date(2026,9,19,14).getTime()/1000;
 expect(exhaustUntil(undefined,cfg,now,'resets Oct 18 at 1pm')).toBe(new Date(2027,9,18,13).getTime()/1000);
 expect(exhaustUntil(undefined,cfg,now,'resets 1pm')).toBe(new Date(2026,9,20,13).getTime()/1000);
 expect(exhaustUntil(undefined,cfg,now,'resets 11:30pm')).toBe(new Date(2026,9,19,23,30).getTime()/1000);
 expect(exhaustUntil(undefined,cfg,now,'resets Oct 18 at 1pm (Asia/Saigon)')).toBe(Date.parse('2027-10-18T06:00:00Z')/1000);
});
