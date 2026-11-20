import { PluginError } from "@pacer/plugin";
import type { HostClient } from "@pacer/plugin";

/**
 * The assistant's executor backend (spec §3): answers a turn by running the host-issued ask-mode
 * command (`opencode run` or `claude -p`) and reading its JSON events. The host built the command
 * and, for opencode, its config (which carries the turn's grant); this plugin passes the config by
 * reference only.
 */

interface AskCommand { argv: string[]; cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number }
export interface ExecutorReplyParams {
  turnId: string;
  session?: string;
  executor?: { configRef: string; command: AskCommand; fallback?: AskCommand };
}
export interface ReplyResult {
  message: string;
  session?: string;
  tools?: { tool: string; status: string }[];
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; coverage: "measured" | "partial" | "unknown" };
}

type SpawnResult = { code: number; timedOut: boolean } & ({ stdout: string; stderr: string } | { output: { stdout: string; stderr: string } });

/** What one ask-mode CLI run produced. */
export interface RunOutcome { text: string; session?: string; usage: ReplyResult["usage"]; error?: string; tools: { tool: string; status: string }[] }

/** Read opencode's JSON lines: text parts, the session id, token usage and any error event. */
export function parseRun(stdout: string): RunOutcome {
  const text: string[] = [], tools: RunOutcome["tools"] = [];
  let session: string | undefined, error: string | undefined;
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, steps = 0, measured = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; sessionID?: string; part?: Record<string, unknown>; error?: { type?: string; message?: string } };
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event.sessionID === "string") session = event.sessionID;
    const part = event.part ?? {};
    if (event.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (event.type === "tool_use") tools.push({ tool: String(part.tool ?? ""), status: String((part.state as { status?: string } | undefined)?.status ?? "") });
    else if (event.type === "step_finish") {
      steps++;
      const t = part.tokens as { input?: number; output?: number; cache?: { read?: number; write?: number } } | undefined;
      if (t && typeof t.input === "number" && typeof t.output === "number") {
        measured++;
        input += t.input; output += t.output; cacheRead += t.cache?.read ?? 0; cacheWrite += t.cache?.write ?? 0;
      }
    } else if (event.type === "error") error = `${event.error?.type ?? "error"}: ${event.error?.message ?? "the agent failed"}`;
  }
  const coverage = steps === 0 || measured === 0 ? "unknown" : measured === steps ? "measured" : "partial";
  return { text: text.join(""), ...(session ? { session } : {}), error, tools,
    usage: { input, output, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}), coverage } };
}

/**
 * Read Claude Code's `--output-format stream-json` lines: assistant text, session_id, usage on the
 * final result, and any tool_use blocks (status error when the permission layer refused them).
 */
export function parseClaudeRun(stdout: string): RunOutcome {
  const text: string[] = [], tools: RunOutcome["tools"] = [];
  let session: string | undefined, error: string | undefined;
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, measured = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event.session_id === "string") session = event.session_id;
    if (event.type === "assistant") {
      const message = event.message as { content?: unknown; usage?: Record<string, unknown> } | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as { type?: string; text?: string; name?: string; is_error?: boolean };
          if (b.type === "text" && typeof b.text === "string") text.push(b.text);
          else if (b.type === "tool_use") tools.push({ tool: String(b.name ?? ""), status: b.is_error ? "error" : "completed" });
        }
      }
    } else if (event.type === "user") {
      // Tool results: a denied tool often lands here with is_error.
      const message = event.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content)) {
        for (const block of message!.content as { type?: string; name?: string; tool_use_id?: string; is_error?: boolean; content?: string }[]) {
          if (block?.type === "tool_result") {
            const name = typeof block.name === "string" ? block.name : tools.find(t => t.status === "completed")?.tool;
            if (block.is_error && name) {
              const at = tools.findIndex(t => t.tool === name && t.status === "completed");
              if (at >= 0) tools[at] = { tool: name, status: "error" };
              else tools.push({ tool: name, status: "error" });
            }
          }
        }
      }
    } else if (event.type === "result") {
      if (event.is_error === true) error = typeof event.result === "string" ? event.result : "the agent failed";
      else if (typeof event.result === "string" && event.result && !text.length) text.push(event.result);
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
        measured = true;
        input = usage.input_tokens; output = usage.output_tokens;
        cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
        cacheWrite = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
      }
    }
  }
  return {
    text: text.join(""), ...(session ? { session } : {}), error, tools,
    usage: { input, output, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}), coverage: measured ? "measured" : "unknown" },
  };
}

async function readAll(host: Pick<HostClient, "call">, handle: string): Promise<string> {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < 16 * 1024 * 1024;) {
    const { base64 } = await host.call<{ base64: string }>("capability.process.outputChunk", { handle, offset, length: 262144 });
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) break;
    parts.push(bytes); offset += bytes.length;
  }
  return Buffer.concat(parts).toString("utf8");
}

async function run(host: Pick<HostClient, "call">, configRef: string | undefined, c: AskCommand): Promise<{ code: number; timedOut: boolean; stdout: string }> {
  const claude = c.argv[0] === "claude";
  const result = await host.call<SpawnResult>("capability.process.spawn", {
    argv: c.argv, cwd: c.cwd, stdin: c.stdin, timeoutMs: c.timeoutMs,
    env: claude || !configRef ? { ...c.env } : { ...c.env, OPENCODE_CONFIG_CONTENT: { secretRef: configRef } },
  });
  const stdout = "output" in result ? await readAll(host, result.output.stdout) : result.stdout;
  return { code: result.code, timedOut: result.timedOut, stdout };
}

/** A resume that failed before the agent answered: no text, and an error or a non-zero exit. */
const resumeFailed = (r: { code: number; timedOut: boolean }, o: RunOutcome) => !r.timedOut && !o.text && (r.code !== 0 || !!o.error);

export async function reply(p: ExecutorReplyParams, host: Pick<HostClient, "call">, signal: AbortSignal): Promise<ReplyResult> {
  if (!p.executor) throw new PluginError("invalid_input", "The executor backend needs a host-issued ask-mode command.");
  const { configRef, command, fallback } = p.executor;
  const parse = command.argv[0] === "claude" ? parseClaudeRun : parseRun;
  let raw = await run(host, configRef, command), out = parse(raw.stdout);
  if (signal.aborted) throw new PluginError("plugin_unavailable", "The turn was cancelled.");
  // A stored session can be gone (expired, removed, another CLI version): start a new one seeded
  // with the transcript, which the host issued as the fallback command.
  if (p.session && fallback && resumeFailed(raw, out)) {
    raw = await run(host, configRef, fallback); out = parse(raw.stdout);
    if (signal.aborted) throw new PluginError("plugin_unavailable", "The turn was cancelled.");
  }
  if (raw.timedOut) throw new PluginError("plugin_timeout", "The agent did not answer in time.");
  if (!out.text) throw new PluginError("plugin_unavailable", out.error ?? `The agent exited ${raw.code} without an answer.`);
  return { message: out.text, ...(out.session ? { session: out.session } : {}), ...(out.tools.length ? { tools: out.tools.slice(0, 64) } : {}), usage: out.usage };
}

export const handlers = {
  "assistant.reply": (params: unknown, host: HostClient, signal: AbortSignal) => reply(params as ExecutorReplyParams, host, signal),
};
