import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { PluginError } from "@pacer/plugin";
import type { HostClient } from "@pacer/plugin";

/**
 * The assistant's executor backend (spec §3): answers a turn by running the host-issued ask-mode
 * command (`opencode acp`, `claude -p`, or `codex … app-server`) and reading its result. The host
 * built the command and, for opencode/Codex, its plan; the grant is bound only as a secret env
 * reference.
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

/** Read one host ACP or Codex turn result (single JSON object with `acp: true` or `codex: true`). */
export function parseAcpRun(stdout: string): RunOutcome | null {
  try {
    const raw = JSON.parse(stdout.trim()) as {
      acp?: boolean; codex?: boolean; text?: string; session?: string; error?: string; toolsHealthy?: boolean;
      tools?: { tool: string; status: string }[];
      usage?: RunOutcome["usage"];
    };
    if (!raw || (raw.acp !== true && raw.codex !== true)) return null;
    return {
      text: typeof raw.text === "string" ? raw.text : "",
      ...(typeof raw.session === "string" ? { session: raw.session } : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      tools: Array.isArray(raw.tools) ? raw.tools.slice(0, 64) : [],
      usage: raw.usage ?? { input: 0, output: 0, coverage: "unknown" },
    };
  } catch {
    return null;
  }
}

/** Read opencode's JSON lines: text parts, the session id, token usage and any error event. */
export function parseRun(stdout: string): RunOutcome {
  const acp = parseAcpRun(stdout);
  if (acp) return acp;
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

/** What every Claude ask-mode turn must see on the stream-json `system`/`init` event. */
export interface ClaudeInitExpect { permissionMode: string; cwd: string; version: string }

/**
 * Built-in Claude Code plugins that `--safe-mode` still lists on init (path must be `builtin`).
 * Any other plugin source fails the turn.
 */
export const CLAUDE_ASK_BUILTIN_PLUGIN_SOURCES = ["agents-md@builtin", "telemetry@builtin"] as const;
const CLAUDE_ASK_BUILTIN_PLUGIN_SOURCE_SET = new Set<string>(CLAUDE_ASK_BUILTIN_PLUGIN_SOURCES);

const isHookEvent = (event: Record<string, unknown>) => {
  const type = typeof event.type === "string" ? event.type : "";
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  return type === "hook" || type.startsWith("hook_") || subtype.startsWith("hook");
};

/** Compare paths the way Claude's init cwd may realpath them (e.g. /var → /private/var on macOS). */
export function samePath(a: string, b: string): boolean {
  if (a === b || resolve(a) === resolve(b)) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

function pluginName(plugin: unknown): string {
  return plugin && typeof plugin === "object" && "name" in plugin
    ? String((plugin as { name?: unknown }).name ?? "plugin")
    : "plugin";
}

/** True when every listed plugin is an allowlisted builtin (`source` + `path: "builtin"`). */
export function claudePluginsAllowed(plugins: unknown[]): boolean {
  return plugins.every(plugin => {
    if (!plugin || typeof plugin !== "object") return false;
    const p = plugin as { source?: unknown; path?: unknown };
    return typeof p.source === "string" && CLAUDE_ASK_BUILTIN_PLUGIN_SOURCE_SET.has(p.source) && p.path === "builtin";
  });
}

/**
 * Read Claude Code's `--output-format stream-json` lines: assistant text, session_id, usage on the
 * final result, tool_use blocks mapped to tool_result by tool_use_id, and the fail-closed init
 * surface (empty tools/mcp/slash_commands/skills, only allowlisted builtin plugins, matching
 * permissionMode/cwd/version). A missing or non-empty init, or any hook lifecycle event, is an error.
 * The `agents` list on init is ignored: those names are unreachable without the Agent tool, which
 * ask mode disables via `--tools ''`.
 */
export function parseClaudeRun(stdout: string, expect?: ClaudeInitExpect): RunOutcome {
  const text: string[] = [], tools: RunOutcome["tools"] = [];
  const byId = new Map<string, number>();
  let session: string | undefined, error: string | undefined;
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, measured = false;
  let sawInit = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event.session_id === "string") session = event.session_id;
    if (isHookEvent(event)) {
      error = error ?? "a Claude hook lifecycle event ran";
      tools.push({ tool: "claude:hook", status: "present" });
      continue;
    }
    if (event.type === "system" && event.subtype === "init") {
      sawInit = true;
      const listed = Array.isArray(event.tools) ? event.tools.map(String) : null;
      const mcp = Array.isArray(event.mcp_servers) ? event.mcp_servers : null;
      const plugins = Array.isArray(event.plugins) ? event.plugins : null;
      const slash = Array.isArray(event.slash_commands) ? event.slash_commands : null;
      const skills = Array.isArray(event.skills) ? event.skills : null;
      // event.agents is intentionally unread: built-in agent names remain listed under --safe-mode
      // but cannot run without the Agent tool, which --tools '' removes.
      const mode = typeof event.permissionMode === "string" ? event.permissionMode : "";
      const cwd = typeof event.cwd === "string" ? event.cwd : "";
      const version = typeof event.claude_code_version === "string" ? event.claude_code_version : "";
      const pluginsOk = !!plugins && claudePluginsAllowed(plugins);
      const empty = !!listed && listed.length === 0 && !!mcp && mcp.length === 0 && pluginsOk
        && !!slash && slash.length === 0
        && (skills === null || skills.length === 0);
      const matches = !expect || (mode === expect.permissionMode && samePath(cwd, expect.cwd) && version === expect.version);
      if (empty && matches) tools.push({ tool: "claude:init", status: "empty" });
      else {
        if (listed) for (const name of listed) tools.push({ tool: name, status: "available" });
        if (mcp) for (const server of mcp) {
          const name = server && typeof server === "object" && "name" in server ? String((server as { name?: unknown }).name ?? "mcp") : "mcp";
          tools.push({ tool: name, status: "available" });
        }
        if (plugins) for (const plugin of plugins) tools.push({ tool: pluginName(plugin), status: "available" });
        if (slash) for (const name of slash) tools.push({ tool: String(name), status: "available" });
        if (!empty) error = error ?? "claude init surface was not empty";
        else if (!matches) error = error ?? "claude init did not match the issued ask-mode turn";
      }
      continue;
    }
    if (event.type === "assistant") {
      const message = event.message as { content?: unknown; usage?: Record<string, unknown> } | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as { type?: string; text?: string; name?: string; id?: string };
          if (b.type === "text" && typeof b.text === "string") text.push(b.text);
          else if (b.type === "tool_use") {
            const idx = tools.push({ tool: String(b.name ?? ""), status: "completed" }) - 1;
            if (typeof b.id === "string" && b.id) byId.set(b.id, idx);
          }
        }
      }
    } else if (event.type === "user") {
      // Tool results carry tool_use_id; map each result to its call (F5).
      const message = event.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content)) {
        for (const block of message!.content as { type?: string; tool_use_id?: string; is_error?: boolean }[]) {
          if (block?.type !== "tool_result" || !block.is_error) continue;
          const idx = typeof block.tool_use_id === "string" ? byId.get(block.tool_use_id) : undefined;
          if (idx !== undefined) tools[idx] = { tool: tools[idx]!.tool, status: "error" };
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
  if (expect && !sawInit) error = error ?? "claude stream-json init event was missing";
  return {
    text: text.join(""), ...(session ? { session } : {}), error, tools,
    usage: { input, output, ...(cacheRead ? { cacheRead } : {}), ...(cacheWrite ? { cacheWrite } : {}), coverage: measured ? "measured" : "unknown" },
  };
}

/** Expected init surface from a host-issued claude ask-mode command. */
export function claudeExpectFromCommand(c: AskCommand): ClaudeInitExpect | null {
  if (c.argv[0] !== "claude") return null;
  const modeAt = c.argv.indexOf("--permission-mode");
  const version = c.env.CLAUDE_CODE_EXPECT_VERSION;
  if (modeAt < 0 || !c.argv[modeAt + 1] || !version) return null;
  return { permissionMode: c.argv[modeAt + 1]!, cwd: c.cwd, version };
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

/** Well-known secret refs the host binds for opencode ACP / Codex; names only, never values. */
const ASK_GRANT_REF = "secrets:assistantAskGrant";

async function run(host: Pick<HostClient, "call">, configRef: string | undefined, c: AskCommand): Promise<{ code: number; timedOut: boolean; stdout: string }> {
  const claude = c.argv[0] === "claude";
  const acp = c.argv[0] === "opencode" && c.argv[1] === "acp";
  const codex = c.argv[0] === "codex";
  const env = claude
    ? { ...c.env }
    : codex
      ? { ...c.env, PACER_ASSISTANT_GRANT: { secretRef: ASK_GRANT_REF } }
      : !configRef
        ? { ...c.env }
        : {
            ...c.env,
            OPENCODE_CONFIG_CONTENT: { secretRef: configRef },
            ...(acp ? { PACER_ASSISTANT_GRANT: { secretRef: ASK_GRANT_REF } } : {}),
          };
  const result = await host.call<SpawnResult>("capability.process.spawn", {
    argv: c.argv, cwd: c.cwd, stdin: c.stdin, timeoutMs: c.timeoutMs, env,
  });
  const stdout = "output" in result ? await readAll(host, result.output.stdout) : result.stdout;
  return { code: result.code, timedOut: result.timedOut, stdout };
}

/** A resume that failed before the agent answered: no text, and an error or a non-zero exit. */
const resumeFailed = (r: { code: number; timedOut: boolean }, o: RunOutcome) => !r.timedOut && !o.text && (r.code !== 0 || !!o.error);

function parseAsk(command: AskCommand, stdout: string): RunOutcome {
  if (command.argv[0] === "claude") {
    const expect = claudeExpectFromCommand(command);
    if (!expect) throw new PluginError("plugin_refused", "The claude ask-mode command was missing its expected init surface.");
    return parseClaudeRun(stdout, expect);
  }
  // opencode acp / Codex app-server (and legacy run fixtures): parseRun accepts host JSON and JSONL.
  return parseRun(stdout);
}

export async function reply(p: ExecutorReplyParams, host: Pick<HostClient, "call">, signal: AbortSignal): Promise<ReplyResult> {
  if (!p.executor) throw new PluginError("invalid_input", "The executor backend needs a host-issued ask-mode command.");
  const { configRef, command, fallback } = p.executor;
  let raw = await run(host, configRef, command), out = parseAsk(command, raw.stdout);
  if (signal.aborted) throw new PluginError("plugin_unavailable", "The turn was cancelled.");
  // A stored session can be gone (expired, removed, another CLI version): start a new one seeded
  // with the transcript, which the host issued as the fallback command.
  if (p.session && fallback && resumeFailed(raw, out)) {
    raw = await run(host, configRef, fallback); out = parseAsk(fallback, raw.stdout);
    if (signal.aborted) throw new PluginError("plugin_unavailable", "The turn was cancelled.");
  }
  if (raw.timedOut) throw new PluginError("plugin_timeout", "The agent did not answer in time.");
  // Claude: a missing/non-empty init or a hook event fails the turn even when text arrived.
  if (command.argv[0] === "claude" && out.error) throw new PluginError("plugin_refused", out.error);
  if (!out.text) throw new PluginError("plugin_unavailable", out.error ?? `The agent exited ${raw.code} without an answer.`);
  return { message: out.text, ...(out.session ? { session: out.session } : {}), ...(out.tools.length ? { tools: out.tools.slice(0, 64) } : {}), usage: out.usage };
}

export const handlers = {
  "assistant.reply": (params: unknown, host: HostClient, signal: AbortSignal) => reply(params as ExecutorReplyParams, host, signal),
};
