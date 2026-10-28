import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseRunnerId } from "../config/runner-id";
import type { AttemptTokens } from "../tasks/types";

/** Everything below treats the log as untrusted: executor output can echo repository content. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_EVENTS = 200_000;
export const MAX_TOKENS = 1_000_000_000;
const TRAILER_WINDOW = 16 * 1024;

export interface ExtractInput {
  /** Runner id of the attempt, e.g. "codex" or "claude-code". */
  executor: string;
  /** Text of the attempt log, or null when it is missing or unreadable. */
  log: string | null;
  /** True when only the end of an oversized log was kept. */
  truncated?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  /** Interactive takeover: the log mixes in a live session pacer cannot attribute. */
  takeover?: boolean;
  now: number;
}

export interface TokenExtractor {
  /** Id and version. A newer version may replace an older row, never a measured row with less. */
  id: string;
  agents: readonly string[];
  extract(input: ExtractInput): AttemptTokens;
}

export function agentOf(executor: string): string { return parseRunnerId(executor)?.agent ?? executor; }

function record(extractor: string, input: ExtractInput, fields: Partial<AttemptTokens> & Pick<AttemptTokens, "coverage" | "source">): AttemptTokens {
  return {
    input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total: null, turns: null,
    selfReported: false, extractor, capturedAt: input.now, ...fields,
  };
}
export function unknownTokens(extractor: string, input: Pick<ExtractInput, "now">, note: string, source: AttemptTokens["source"] = "executor-text"): AttemptTokens {
  return record(extractor, input as ExtractInput, { coverage: "unknown", source, note });
}

/** A count is a non-negative safe integer no larger than MAX_TOKENS; anything else is rejected, not clamped. */
function count(value: unknown): number | null | "bad" {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : "bad";
}

/** Read a log with a size cap; keep the tail of an oversized file because usage is reported at the end. */
export function readLogText(path: string): { text: string; truncated: boolean } | null {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null; // never open a FIFO, device or symlink
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_LOG_BYTES), buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) { const n = readSync(fd, buffer, offset, length - offset, size - length + offset); if (!n) break; offset += n; }
    return { text: buffer.toString("utf8", 0, offset), truncated: size > MAX_LOG_BYTES };
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* read-only handle */ } }
}
export function readGzipLogText(path: string): { text: string; truncated: boolean } | null {
  const raw = readLogBytes(path);
  if (!raw) return null;
  try { return { text: gunzipSync(raw, { maxOutputLength: MAX_LOG_BYTES }).toString("utf8"), truncated: false }; }
  catch { return null; }
}
function readLogBytes(path: string): Buffer | null {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size > MAX_LOG_BYTES) return null;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) { const n = readSync(fd, buffer, offset, size - offset, offset); if (!n) break; offset += n; }
    return buffer.subarray(0, offset);
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* read-only handle */ } }
}

/**
 * Codex prints one total ("tokens used" then the number) as the last output before pacer writes the
 * "--- exit" line. Only that trailer counts: it must be followed by nothing but blank lines, the exit line
 * and pacer's own routing note. The number is stdout text, so it is labelled self-reported.
 */
function codexTrailer(tail: string): string | null {
  const lines = tail.split("\n");
  let exit = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^--- exit( |$)/.test(lines[i]!)) { exit = i; break; }
  if (exit < 0) return null;
  const after = lines.slice(exit + 1).join("\n").trimStart();
  if (after && !after.startsWith("--- routing\n") && after !== "--- routing") return null;
  let i = exit - 1;
  while (i >= 0 && lines[i]!.trim() === "") i--;
  return i >= 1 && lines[i - 1] === "tokens used" && /^[0-9][0-9,]{0,15}$/.test(lines[i]!) ? lines[i]! : null;
}
export const codexTextExtractor: TokenExtractor = {
  id: "codex-text@1", agents: ["codex"],
  extract(input) {
    const id = this.id;
    if (input.takeover) return unknownTokens(id, input, "interactive takeover is not attributed to the executor");
    if (input.log === null || !input.log.trim()) return unknownTokens(id, input, "attempt log is empty or unreadable");
    const digits = codexTrailer(input.log.slice(-TRAILER_WINDOW));
    if (!digits) return unknownTokens(id, input, "no final token total in the log");
    const total = Number(digits.replace(/,/g, ""));
    if (!Number.isSafeInteger(total) || total > MAX_TOKENS) return unknownTokens(id, input, "token total is out of range");
    return record(id, input, { coverage: "partial", source: "executor-text", selfReported: true, total, note: "total only; no input/output split" });
  },
};

/**
 * Claude Code's stream-json run. The input is the reduced usage file pacer writes (see reduceClaudeStream),
 * never the log: the log holds result text the model can write. The final `result` event carries the usage of the whole run. A run
 * that ended without one keeps the usage of the assistant messages seen so far, as a lower bound.
 */
interface ClaudeUsage { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }
function claudeUsage(raw: unknown): ClaudeUsage | "bad" | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const input = count(u.input_tokens), output = count(u.output_tokens), cacheRead = count(u.cache_read_input_tokens), cacheWrite = count(u.cache_creation_input_tokens);
  if ([input, output, cacheRead, cacheWrite].includes("bad")) return "bad";
  const usage = { input, output, cacheRead, cacheWrite } as ClaudeUsage;
  return Object.values(usage).every(v => v === null) ? null : usage;
}
export const claudeStreamJsonExtractor: TokenExtractor = {
  id: "claude-stream-json@1", agents: ["claude-code"],
  extract(input) {
    const id = this.id;
    if (input.takeover) return unknownTokens(id, input, "interactive takeover is not attributed to the executor", "executor-json");
    if (input.log === null || !input.log.trim()) return unknownTokens(id, input, "attempt log is empty or unreadable", "executor-json");
    let result: { usage: ClaudeUsage; turns: number | null } | undefined, bad = false, events = 0, overlong = 0;
    const messages = new Map<string, ClaudeUsage>();
    for (const line of input.log.split("\n")) {
      if (!line.startsWith("{")) continue;
      if (line.length > MAX_LINE_BYTES) { overlong++; continue; }
      if (++events > MAX_EVENTS) break;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== "object") continue;
      if (event.type === "result") {
        const usage = claudeUsage(event.usage);
        if (usage === "bad") { bad = true; continue; }
        const turns = count(event.num_turns);
        if (usage) { result = { usage, turns: turns === "bad" ? null : turns }; bad = false; }
      } else if (event.type === "assistant") {
        const message = event.message as { id?: unknown; usage?: unknown } | undefined;
        const usage = claudeUsage(message?.usage);
        if (usage === "bad") { bad = true; continue; }
        if (usage && typeof message?.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(message.id)) {
          const seen = messages.get(message.id);
          const max = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
          messages.set(message.id, seen ? { input: max(seen.input, usage.input), output: max(seen.output, usage.output), cacheRead: max(seen.cacheRead, usage.cacheRead), cacheWrite: max(seen.cacheWrite, usage.cacheWrite) } : usage);
        }
      }
    }
    const over = (u: ClaudeUsage) => u.input !== null && u.output !== null && u.input + u.output > MAX_TOKENS;
    const fromParts = (u: ClaudeUsage): Pick<AttemptTokens, "input" | "output" | "cacheRead" | "cacheWrite" | "total"> =>
      ({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.input === null || u.output === null ? null : u.input + u.output });
    if (result && over(result.usage)) return unknownTokens(id, input, "usage total is out of range", "executor-json");
    if (result) {
      const fields = fromParts(result.usage);
      const complete = fields.total !== null && !input.truncated;
      return record(id, input, { coverage: complete ? "measured" : "partial", source: "executor-json", ...fields, turns: result.turns,
        ...(complete ? {} : { note: input.truncated ? "log was larger than the read limit" : "usage lacked input or output tokens" }) });
    }
    if (messages.size) {
      const sum = (key: keyof ClaudeUsage) => { let t: number | null = null; for (const m of messages.values()) if (m[key] !== null) t = (t ?? 0) + m[key]!; return t; };
      const parts: ClaudeUsage = { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") };
      if (over(parts)) return unknownTokens(id, input, "usage total is out of range", "executor-json");
      const ended = input.timedOut ? "timed out" : "ended";
      return record(id, input, { coverage: "partial", source: "executor-json", ...fromParts(parts), turns: messages.size,
        note: `attempt ${ended} before a final result event; sum of messages seen, a lower bound` });
    }
    const why = bad ? "usage fields were negative, non-integer or out of range" : overlong ? "usage events were over the line limit" : "no usable usage event (missing or out of range)";
    return unknownTokens(id, input, why, "executor-json");
  },
};

/**
 * pacer replaces a Claude run's raw stream with its result text before it writes the log, so the usage
 * has to be taken from the stream first. This keeps only numeric usage fields, in the same event shape,
 * so the reduced text can be fed to the extractor and holds no prompt, output or path.
 */
export const USAGE_FILE = "usage.jsonl";
export function reduceClaudeStream(raw: string): string {
  const out: string[] = [];
  let events = 0;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{") || line.length > MAX_LINE_BYTES) continue;
    if (++events > MAX_EVENTS) break;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== "object") continue;
    const message = event.message as { id?: unknown; usage?: unknown } | undefined;
    const usage = claudeUsage(event.type === "assistant" ? message?.usage : event.usage);
    if (!usage || usage === "bad") continue;
    const numbers = { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite };
    if (event.type === "result") {
      const turns = count(event.num_turns);
      out.push(JSON.stringify({ type: "result", ...(typeof turns === "number" ? { num_turns: turns } : {}), usage: numbers }));
    } else if (event.type === "assistant" && typeof message?.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(message.id)) {
      out.push(JSON.stringify({ type: "assistant", message: { id: message.id, usage: numbers } }));
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

const EXTRACTORS: readonly TokenExtractor[] = [codexTextExtractor, claudeStreamJsonExtractor];
export function extractorFor(executor: string): TokenExtractor | undefined {
  const agent = agentOf(executor);
  return EXTRACTORS.find(e => e.agents.includes(agent));
}

/** Never throws: a parsing problem is an `unknown` record, not a failed run. */
export function extractAttemptTokens(input: ExtractInput): AttemptTokens {
  const extractor = extractorFor(input.executor);
  if (!extractor) return unknownTokens("none@1", input, `no usage extractor for ${agentOf(input.executor)}`);
  try { return extractor.extract(input); }
  catch { return unknownTokens(extractor.id, input, "usage extraction failed"); }
}
