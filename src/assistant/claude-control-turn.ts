/**
 * One Claude Code ask-mode turn over the CLI's stream-json CONTROL protocol (spec §3).
 * The host runs this inside `capability.process.spawn` (mode `claude-control`) so the per-turn
 * grant stays in the resolved environment and never reaches the plugin. Every tool call is decided
 * here fail-closed: allow only the exact `mcp__pacer__*` names the host passed; deny everything else.
 *
 * Wire shape (CLI `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`):
 * host→cli control_request (initialize, mcp_status, interrupt) and user messages;
 * cli→host control_response, can_use_tool control_request, and stream-json assistant/result/init events.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Kept here (not imported from ask-mode) to avoid a cycle; keep wording aligned with ASK_TOOLS_UNAVAILABLE. */
const TOOLS_UNAVAILABLE_NOTE =
  "[pacer] Your pacer read tools are unavailable in this session. Answer only from the digest and conversation; do not invent tool results.";

export const CLAUDE_CONTROL_PLAN_VERSION = 1 as const;

/**
 * Matches ask-mode's CONTROL identity + security belt (kept here to avoid an import cycle with
 * ask-mode / capability-spawn). Fail closed at issuance: identity alone is not enough.
 */
const CONTROL_PERMISSION_PROMPTS = "host";
const CONTROL_PERMISSION_PROMPT_TOOL = "stdio";
const CONTROL_PERMISSION_MODE = "dontAsk";
const CONTROL_ASK_SETTINGS = '{"disableAllHooks":true}';
const CONTROL_ALLOWED_PACER_TOOLS = "mcp__pacer__*";

function flagValue(argv: readonly string[], name: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** True when argv is a host-issued Claude CONTROL ask-mode command with the full security flag belt. */
export function isClaudeControlArgv(argv: readonly string[]): boolean {
  if (argv[0] !== "claude" || !argv.includes("-p")) return false;
  if (!argv.includes("--verbose")) return false;
  if (!argv.includes("--strict-mcp-config")) return false;
  if (!argv.includes("--safe-mode")) return false;
  if (!argv.includes("--disable-slash-commands")) return false;
  if (!argv.includes("--include-hook-events")) return false;
  if (flagValue(argv, "--input-format") !== "stream-json") return false;
  if (flagValue(argv, "--output-format") !== "stream-json") return false;
  if (flagValue(argv, "--permission-prompt-tool") !== CONTROL_PERMISSION_PROMPT_TOOL) return false;
  if (flagValue(argv, "--permission-prompts") !== CONTROL_PERMISSION_PROMPTS) return false;
  if (flagValue(argv, "--permission-mode") !== CONTROL_PERMISSION_MODE) return false;
  if (flagValue(argv, "--settings") !== CONTROL_ASK_SETTINGS) return false;
  // Empty tools / setting-sources (host issues `--tools=` / `--setting-sources=`).
  if (flagValue(argv, "--tools") !== "") return false;
  if (flagValue(argv, "--setting-sources") !== "") return false;
  if (flagValue(argv, "--mcp-config") === undefined) return false;
  if (flagValue(argv, "--system-prompt-file") === undefined) return false;
  const disallowed = flagValue(argv, "--disallowedTools");
  if (disallowed === undefined || disallowed.length === 0) return false;
  // Digest-only omits --allowedTools; MCP turns must be exactly the pacer wildcard.
  const allowed = flagValue(argv, "--allowedTools");
  if (allowed !== undefined && allowed !== CONTROL_ALLOWED_PACER_TOOLS) return false;
  return true;
}

/** Host-issued Claude control plan on the pinned command's stdin (no grant values). */
export interface ClaudeControlPlan {
  v: typeof CLAUDE_CONTROL_PLAN_VERSION;
  prompt: string;
  /** Seeded transcript prompt when resume fails inside the driver (unused when the host issues a separate fallback pin). */
  fallbackPrompt?: string;
  /** Exact `mcp__pacer__*` names the host allowed for this turn. */
  allowedTools: string[];
  /** When false, skip MCP health and answer digest-only. */
  tools: boolean;
  permissionMode: string;
  cwd: string;
  expectVersion?: string;
  turnId?: string;
}

export interface ClaudeControlTurnResult {
  text: string;
  session?: string;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; coverage: "measured" | "partial" | "unknown" };
  tools: { tool: string; status: string }[];
  toolsHealthy: boolean;
  error?: string;
  deltas: string[];
}

export interface ClaudeControlTurnHooks {
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse the host-issued Claude control plan from pinned stdin. */
export function parseClaudeControlPlan(stdin: string): ClaudeControlPlan | null {
  try {
    const plan = JSON.parse(stdin) as ClaudeControlPlan;
    if (plan?.v !== CLAUDE_CONTROL_PLAN_VERSION || typeof plan.prompt !== "string") return null;
    if (!Array.isArray(plan.allowedTools) || typeof plan.tools !== "boolean") return null;
    if (typeof plan.permissionMode !== "string" || typeof plan.cwd !== "string") return null;
    if (plan.allowedTools.some(t => typeof t !== "string")) return null;
    return plan;
  } catch {
    return null;
  }
}

/** True when the tool name is one of the exact host-passed pacer MCP tools. */
export function isAllowedPacerTool(allowed: readonly string[], name: string): boolean {
  return allowed.includes(name);
}

function mcpServersFromStatus(response: unknown): { name: string; status: string }[] {
  if (Array.isArray(response)) {
    return response.flatMap(s => {
      if (!isRecord(s) || typeof s.name !== "string") return [];
      return [{ name: s.name, status: typeof s.status === "string" ? s.status : "unknown" }];
    });
  }
  if (!isRecord(response)) return [];
  const listed = response.mcpServers ?? response.servers ?? response.mcp_servers;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap(s => {
    if (!isRecord(s) || typeof s.name !== "string") return [];
    return [{ name: s.name, status: typeof s.status === "string" ? s.status : "unknown" }];
  });
}

/**
 * Fail closed: pacer must be the only connected server, and every expected tool name must be
 * present in the status payload. A bare server list (array or object without tools) cannot
 * confirm the tool set when `allowedTools` is non-empty.
 */
export function mcpStatusHealthy(
  response: unknown,
  allowedTools: readonly string[],
): boolean {
  const servers = mcpServersFromStatus(response);
  if (servers.length !== 1) return false;
  const pacer = servers[0]!;
  if (pacer.name !== "pacer" || pacer.status !== "connected") return false;
  if (!isRecord(response)) return allowedTools.length === 0;
  const tools = response.tools ?? response.toolNames;
  if (tools === undefined) return allowedTools.length === 0;
  if (!Array.isArray(tools)) return false;
  const names = tools.map(String);
  if (names.length !== allowedTools.length) return false;
  const want = new Set(allowedTools);
  const have = new Set(names);
  return names.every(n => want.has(n)) && allowedTools.every(n => have.has(n));
}

function samePathLoose(a: string, b: string): boolean {
  if (a === b || resolve(a) === resolve(b)) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

const CLAUDE_ASK_BUILTIN_PLUGIN_SOURCES = new Set(["agents-md@builtin", "telemetry@builtin"]);

function pluginsAllowed(plugins: unknown[]): boolean {
  return plugins.every(plugin => {
    if (!isRecord(plugin)) return false;
    return typeof plugin.source === "string"
      && CLAUDE_ASK_BUILTIN_PLUGIN_SOURCES.has(plugin.source)
      && plugin.path === "builtin";
  });
}

function sameToolSet(listed: string[], expected: string[]): boolean {
  if (listed.length !== expected.length) return false;
  const want = new Set(expected);
  return listed.every(name => want.has(name));
}

/**
 * Drive one Claude stream-json CONTROL session on an already-spawned child. Pin stdin is the plan
 * (host metadata), not bytes for the child: the child's stdin is control + user stream-json frames.
 */
export async function runClaudeControlTurn(
  child: ChildProcessWithoutNullStreams,
  plan: ClaudeControlPlan,
  hooks: ClaudeControlTurnHooks = {},
): Promise<ClaudeControlTurnResult> {
  const tools: ClaudeControlTurnResult["tools"] = [];
  const deltas: string[] = [];
  const textParts: string[] = [];
  let session: string | undefined;
  let toolsHealthy = false;
  let error: string | undefined;
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, measured = false;
  let sawInit = false;
  let finished = false;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const write = (frame: Json, opts: { evenIfAborted?: boolean } = {}) => {
    if (!opts.evenIfAborted && hooks.signal?.aborted) throw new Error("The turn was cancelled.");
    if (child.stdin.destroyed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };

  const controlRequest = (subtype: string, extra: Json = {}, opts: { evenIfAborted?: boolean } = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const request_id = randomUUID();
      pending.set(request_id, { resolve, reject });
      write({ type: "control_request", request_id, request: { subtype, ...extra } }, opts);
    });

  const replyCanUse = (request_id: string, response: Json) => {
    write({ type: "control_response", response: { subtype: "success", request_id, response } });
  };

  const denyTool = (request_id: string, toolName: string, toolUseId: string | undefined, reason: string) => {
    tools.push({ tool: toolName || "tool", status: "denied" });
    replyCanUse(request_id, {
      behavior: "deny",
      message: reason,
      ...(toolUseId ? { toolUseID: toolUseId } : {}),
    });
  };

  const allowTool = (request_id: string, toolName: string, input: unknown, toolUseId: string | undefined) => {
    tools.push({ tool: toolName, status: "allowed" });
    replyCanUse(request_id, {
      behavior: "allow",
      updatedInput: isRecord(input) ? input : {},
      ...(toolUseId ? { toolUseID: toolUseId } : {}),
    });
  };

  const isHookEvent = (event: Json) => {
    const type = typeof event.type === "string" ? event.type : "";
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    return type === "hook" || type.startsWith("hook_") || subtype.startsWith("hook");
  };

  const onInit = (event: Json) => {
    sawInit = true;
    if (typeof event.session_id === "string") session = event.session_id;
    const listed = Array.isArray(event.tools) ? event.tools.map(String) : null;
    const mcp = Array.isArray(event.mcp_servers) ? event.mcp_servers : null;
    const plugins = Array.isArray(event.plugins) ? event.plugins : null;
    const slash = Array.isArray(event.slash_commands) ? event.slash_commands : null;
    const skills = Array.isArray(event.skills) ? event.skills : null;
    const mode = typeof event.permissionMode === "string" ? event.permissionMode : "";
    const cwd = typeof event.cwd === "string" ? event.cwd : "";
    const version = typeof event.claude_code_version === "string" ? event.claude_code_version : "";
    const pluginsOk = !!plugins && pluginsAllowed(plugins);
    const slashOk = !!slash && slash.length === 0;
    const skillsOk = skills === null || skills.length === 0;
    const matches = mode === plan.permissionMode
      && samePathLoose(cwd, plan.cwd)
      && (!plan.expectVersion || version === plan.expectVersion);
    const wantPacer = plan.tools;
    const wantTools = plan.allowedTools;
    const pacerConnected = !!mcp && mcp.length === 1 && isRecord(mcp[0])
      && mcp[0].name === "pacer" && mcp[0].status === "connected";
    const pacerFailed = !mcp || !mcp.some(s => isRecord(s) && s.name === "pacer" && s.status === "connected");
    const surfaceOk = wantPacer
      ? !!listed && sameToolSet(listed, wantTools) && pacerConnected && pluginsOk && slashOk && skillsOk
      : !!listed && listed.length === 0 && !!mcp && mcp.length === 0 && pluginsOk && slashOk && skillsOk;
    if (surfaceOk && matches) {
      tools.push({ tool: "claude:init", status: wantPacer ? "pacer" : "empty" });
    } else {
      if (listed) for (const name of listed) tools.push({ tool: name, status: "available" });
      if (mcp) for (const server of mcp) {
        if (!isRecord(server)) continue;
        tools.push({
          tool: String(server.name ?? "mcp"),
          status: String(server.status ?? "available"),
        });
      }
      if (plugins) for (const plugin of plugins) {
        const name = isRecord(plugin) ? String(plugin.name ?? "plugin") : "plugin";
        tools.push({ tool: name, status: "available" });
      }
      if (slash) for (const name of slash) tools.push({ tool: String(name), status: "available" });
      if (wantPacer && pacerFailed) error = error ?? "claude pacer MCP server failed to connect";
      else if (!surfaceOk) error = error ?? (wantPacer ? "claude init did not expose exactly the pacer MCP tools" : "claude init surface was not empty");
      else if (!matches) error = error ?? "claude init did not match the issued ask-mode turn";
    }
  };

  const onLine = (line: string) => {
    if (!line.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(line) as Json; } catch {
      error = error ?? "malformed Claude control message";
      finished = true;
      for (const [, w] of pending) w.reject(new Error("malformed Claude control message"));
      pending.clear();
      return;
    }
    if (typeof msg.session_id === "string") session = msg.session_id;

    if (msg.type === "control_response" && isRecord(msg.response)) {
      const response = msg.response;
      const requestId = typeof response.request_id === "string" ? response.request_id : "";
      const wait = requestId ? pending.get(requestId) : undefined;
      if (!wait) return;
      pending.delete(requestId);
      if (response.subtype === "error") {
        wait.reject(new Error(typeof response.error === "string" ? response.error : "control request failed"));
        return;
      }
      wait.resolve(response.response);
      return;
    }

    if (msg.type === "control_request" && typeof msg.request_id === "string" && isRecord(msg.request)) {
      const request_id = msg.request_id;
      const req = msg.request;
      const subtype = typeof req.subtype === "string" ? req.subtype : "";
      if (subtype === "can_use_tool") {
        const toolName = typeof req.tool_name === "string" ? req.tool_name : "";
        const toolUseId = typeof req.tool_use_id === "string" ? req.tool_use_id : undefined;
        const input = req.input;
        // Digest-only or unhealthy: deny everything. Otherwise allow only exact host-passed names.
        if (!toolsHealthy || !isAllowedPacerTool(plan.allowedTools, toolName)) {
          denyTool(request_id, toolName, toolUseId, "pacer ask mode allows only the host-issued pacer MCP tools");
          return;
        }
        allowTool(request_id, toolName, input, toolUseId);
        return;
      }
      // Unknown inbound control: fail closed.
      replyCanUse(request_id, { behavior: "deny", message: `unsupported control subtype: ${subtype || "unknown"}` });
      return;
    }

    if (isHookEvent(msg)) {
      error = "a Claude hook lifecycle event ran";
      tools.push({ tool: "claude:hook", status: "present" });
      return;
    }

    if (msg.type === "system" && msg.subtype === "init") {
      onInit(msg);
      return;
    }

    if (msg.type === "assistant") {
      const message = msg.message as { content?: unknown; usage?: Record<string, unknown> } | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
            deltas.push(block.text);
            hooks.onDelta?.(block.text);
          } else if (block.type === "tool_use") {
            const name = String(block.name ?? "");
            const idx = tools.findIndex(t => t.tool === name && (t.status === "allowed" || t.status === "denied"));
            if (idx < 0) tools.push({ tool: name, status: "completed" });
            else if (tools[idx]!.status === "allowed") tools[idx] = { tool: name, status: "completed" };
          }
        }
      }
      return;
    }

    if (msg.type === "user") {
      const message = msg.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content)) {
        for (const block of message!.content as { type?: string; tool_use_id?: string; is_error?: boolean; name?: string }[]) {
          if (block?.type !== "tool_result" || !block.is_error) continue;
          // Mark the most recent matching completed/allowed tool as error.
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i]!.status === "completed" || tools[i]!.status === "allowed") {
              tools[i] = { tool: tools[i]!.tool, status: "error" };
              break;
            }
          }
        }
      }
      return;
    }

    if (msg.type === "result") {
      finished = true;
      if (msg.is_error === true) error = typeof msg.result === "string" ? msg.result : "the agent failed";
      else if (typeof msg.result === "string" && msg.result && !textParts.length) textParts.push(msg.result);
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
        measured = true;
        input = usage.input_tokens;
        output = usage.output_tokens;
        cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
        cacheWrite = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
      }
      for (const [, w] of pending) w.reject(new Error("Claude turn ended"));
      pending.clear();
    }
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", onLine);
  child.stderr?.resume();

  const interruptThenKill = () => {
    // Fire interrupt without waiting for a reply; then escalate to signals.
    try {
      write({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      }, { evenIfAborted: true });
    } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 100).unref?.();
    for (const [, w] of pending) w.reject(new Error("The turn was cancelled."));
    pending.clear();
  };
  const onAbort = () => { interruptThenKill(); };
  hooks.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (hooks.signal?.aborted) throw new Error("The turn was cancelled.");

    // initialize with empty hooks (host answers can_use_tool; settings already disableAllHooks).
    await controlRequest("initialize", { hooks: {} });

    // Wait briefly for the stream-json init event if it has not arrived with initialize.
    if (!sawInit) {
      await Promise.race([
        new Promise<void>(r => {
          const check = setInterval(() => { if (sawInit) { clearInterval(check); r(); } }, 5);
          setTimeout(() => { clearInterval(check); r(); }, 2_000).unref?.();
        }),
        new Promise<void>((_, rej) => hooks.signal?.addEventListener("abort", () => rej(new Error("The turn was cancelled.")), { once: true })),
      ]);
    }
    if (!sawInit) error = error ?? "claude stream-json init event was missing";

    // MCP health via control protocol (Orca polls mcpServerStatus → subtype mcp_status).
    if (plan.tools && !error?.includes("hook")) {
      try {
        const status = await controlRequest("mcp_status");
        toolsHealthy = mcpStatusHealthy(status, plan.allowedTools)
          && tools.some(t => t.tool === "claude:init" && t.status === "pacer");
      } catch {
        toolsHealthy = false;
      }
      if (!toolsHealthy) {
        // Init may already have recorded a connect failure; prefer digest-only for this turn.
        if (!error || /pacer MCP server failed to connect/i.test(error)) {
          error = "pacer MCP tools were not confirmed via mcp_status; answering from the digest only";
        }
        // Clear a failed pacer init marker so digest-only evidence can stand if we re-mark empty.
        const initIdx = tools.findIndex(t => t.tool === "claude:init");
        if (initIdx >= 0 && tools[initIdx]!.status === "pacer" && !toolsHealthy) {
          // Keep the init record; health false drives deny-all + unavailable note.
        }
      }
    } else if (!plan.tools) {
      toolsHealthy = false;
    }

    // A hard init/hook failure still ends the turn without prompting when hooks fired.
    if (tools.some(t => t.tool === "claude:hook")) {
      return {
        text: textParts.join(""),
        ...(session ? { session } : {}),
        usage: {
          input, output,
          ...(cacheRead ? { cacheRead } : {}),
          ...(cacheWrite ? { cacheWrite } : {}),
          coverage: measured ? "measured" : "unknown",
        },
        tools: tools.slice(0, 64),
        toolsHealthy: false,
        error: error ?? "a Claude hook lifecycle event ran",
        deltas,
      };
    }

    const promptText = plan.tools && !toolsHealthy
      ? `${TOOLS_UNAVAILABLE_NOTE}\n\n${plan.prompt}`
      : plan.prompt;

    write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: promptText }],
      },
    });

    // Wait until result, cancel, or child close.
    await new Promise<void>((resolve) => {
      if (finished || hooks.signal?.aborted) { resolve(); return; }
      const done = () => resolve();
      child.once("close", done);
      const tick = setInterval(() => {
        if (finished || hooks.signal?.aborted) { clearInterval(tick); resolve(); }
      }, 10);
      tick.unref?.();
    });

    if (!sawInit && !error) error = "claude stream-json init event was missing";

    return {
      text: textParts.join(""),
      ...(session ? { session } : {}),
      usage: {
        input, output,
        ...(cacheRead ? { cacheRead } : {}),
        ...(cacheWrite ? { cacheWrite } : {}),
        coverage: measured ? "measured" : "unknown",
      },
      tools: tools.slice(0, 64),
      toolsHealthy,
      ...(error ? { error } : {}),
      deltas,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      text: textParts.join(""),
      ...(session ? { session } : {}),
      usage: {
        input, output,
        ...(cacheRead ? { cacheRead } : {}),
        ...(cacheWrite ? { cacheWrite } : {}),
        coverage: measured ? "measured" : "unknown",
      },
      tools: tools.slice(0, 64),
      toolsHealthy,
      error: message,
      deltas,
    };
  } finally {
    hooks.signal?.removeEventListener("abort", onAbort);
    rl.close();
    try { child.stdin.end(); } catch { /* ignore */ }
  }
}
