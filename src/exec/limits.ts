import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { parseRunnerId } from "../config/runner-id";
import type { ProviderCfg } from "../config/strategy";
import type { ProviderStatus } from "../engine/rank";
import type { ExecResult } from "./process";

const GENERIC: RegExp[] = [
  /rate[ _-]?limit/i,
  /usage limit/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /too many requests/i,
  /\b429\b/,
  /limit (?:reached|exceeded)/i,
  /out of (?:credits|quota)/i,
  /insufficient (?:quota|credits|balance)/i,
];
/** Provider overload is transient; never mark the subscription exhausted. */
export const TRANSIENT_PROVIDER_PATTERNS = [
  /selected model is at capacity/i,
  /(?:model|provider|server) (?:is )?(?:at capacity|overloaded|busy|temporarily unavailable)/i,
  /overloaded_error/i,
  /service unavailable/i,
];
export function detectTransient(text: string): boolean {
  return TRANSIENT_PROVIDER_PATTERNS.some(pattern => pattern.test(text.slice(-8000)));
}

const SPECIFIC: Record<string, RegExp[]> = {
  codex: [/rate_limit_reached/i, /hit your usage limit/i],
  "claude-code": [/you[’']ve hit your [\w-]+ limit/i],
  cursor: [/^\s*Error: .*\busage limit reached\b/im, /^\s*rateLimitReason: \w+/im],
};

/** True when a FAILED run's output says the provider's plan limit was hit. Timeouts never count. */
export function detectLimit(providerId: string, r: ExecResult): boolean {
  if (r.code === 0 || r.timedOut) return false;
  const text = `${r.stderr}\n${r.stdout}`.slice(-8000);
  return [...GENERIC, ...(SPECIFIC[parseRunnerId(providerId)?.agent ?? providerId] ?? [])].some((re) => re.test(text));
}

/**
 * True when a live interactive session's screen text shows the provider's own limit error. Only provider-specific
 * phrasing counts: a working agent's screen can mention rate limits in code or summaries.
 */
export function detectSessionLimit(providerId: string, text: string): boolean {
  return sessionLimitExcerpt(providerId, text) !== null;
}

/** The session text from the first line of the provider's limit error, or null when there is none. */
export function sessionLimitExcerpt(providerId: string, text: string): string | null {
  const lines = text.slice(-8000).split(/\r?\n/), patterns = SPECIFIC[parseRunnerId(providerId)?.agent ?? providerId] ?? [];
  const at = lines.findIndex(line => patterns.some(re => re.test(line)));
  return at < 0 ? null : lines.slice(at).join("\n").trim().slice(0, 1000);
}

/** Seconds a live session stays quiet before its screen is checked for a provider limit error. */
export const LIMIT_QUIET_S = 15;

function tailText(file: string, bytes: number): string {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return ""; }
  try {
    const size = fstatSync(fd).size, n = Math.min(size, bytes), buffer = Buffer.alloc(n);
    return buffer.subarray(0, readSync(fd, buffer, 0, n, size - n)).toString("utf8");
  } finally { closeSync(fd); }
}

/** A PTY run's recent transcript text without the lines that echo the prompt, which can itself discuss limits. */
export function sessionLimitText(dir: string): string {
  let prompt = "";
  try { prompt = readFileSync(join(dir, "prompt.md"), "utf8"); } catch { /* the prompt was passed on the command line */ }
  const echoed = new Set(prompt.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 8));
  return tailText(join(dir, "stdout"), 16 * 1024).split(/\r?\n/)
    .filter(line => !echoed.has(line.trim()) && !line.includes("prompt.md")).slice(-60).join("\n");
}

const UNIT_S: Record<string, number> = { minute: 60, hour: 3600, day: 86_400 };

/** Parse the reset wall time reported by a CLI, in its stated zone or local time. */
function reportedReset(text: string, now: number): number | null {
  const relative = /\bresets\s+in\s+(\d{1,3})\s+(minute|hour|day)s?\b/i.exec(text);
  if (relative) return now + Number(relative[1]) * UNIT_S[relative[2].toLowerCase()];
  const match = /\bresets\s+(?:([a-z]{3})\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!match) return null;
  const [, month, day, hour, minute, meridiem, zone] = match;
  const h = Number(hour), min = Number(minute ?? 0);
  const mo = month ? ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(month.toLowerCase()) : null;
  if (h < 1 || h > 12 || min > 59 || mo === -1 || (day && (Number(day) < 1 || Number(day) > 31))) return null;
  try {
    const formatter = zone ? new Intl.DateTimeFormat('en-US', {timeZone: zone, year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',hourCycle:'h23'}) : null;
    const parts = (ms: number) => {
      const d = new Date(ms);
      if (!formatter) return [d.getFullYear(), d.getMonth()+1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
      const p = Object.fromEntries(formatter.formatToParts(d).map(v=>[v.type,v.value]));
      return [p.year,p.month,p.day,p.hour,p.minute,p.second].map(Number);
    };
    const current = parts(now*1000);
    const wall = new Date(Date.UTC(current[0], mo ?? current[1]-1, day ? Number(day) : current[2], h%12+(meridiem.toLowerCase()==='pm'?12:0), min));
    // Reject impossible calendar dates instead of silently normalizing them.
    if (day && (wall.getUTCMonth() !== mo || wall.getUTCDate() !== Number(day))) return null;
    const instant = () => {
      if (!formatter) return new Date(wall.getUTCFullYear(),wall.getUTCMonth(),wall.getUTCDate(),wall.getUTCHours(),wall.getUTCMinutes()).getTime()/1000;
      let ms=wall.getTime();
      for(let i=0;i<4;i++) {
        const p=parts(ms), offset=Date.UTC(p[0],p[1]-1,p[2],p[3],p[4],p[5])-ms;
        const next=wall.getTime()-offset;
        if(next===ms) break;
        ms=next;
      }
      return ms/1000;
    };
    let reset=instant();
    if(reset<=now) {
      if(month) wall.setUTCFullYear(wall.getUTCFullYear()+1);
      else wall.setUTCDate(wall.getUTCDate()+1);
      reset=instant();
    }
    return Number.isFinite(reset) && reset>now ? reset : null;
  } catch { return null; } // Invalid IANA zones keep the existing cooldown/window fallback.
}

/** Until when to treat a provider as exhausted after a limit hit. */
export function exhaustUntil(st: ProviderStatus | undefined, cfg: ProviderCfg, now: number, output = ""): number {
  const reported = reportedReset(output.slice(-8000), now);
  if (reported !== null) return reported;
  const resets = (st?.windows ?? [])
    .filter((w) => w.resetsAt !== null && w.resetsAt > now && (w.usedPct ?? 0) >= 90)
    .map((w) => w.resetsAt as number);
  return resets.length ? Math.min(...resets) : now + cfg.cooldownS;
}
