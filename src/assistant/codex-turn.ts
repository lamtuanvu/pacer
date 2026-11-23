/**
 * One Codex app-server ask-mode turn (spec §3): JSON-RPC over the child's stdio. The host runs this
 * inside the plugin-owned `capability.process.spawn` (mode `codex-ask`) so the per-turn grant stays
 * in the resolved environment and never reaches the plugin. Approvals are answered here fail-closed:
 * allow only pacer MCP tool-call elicitations; decline commands, file changes and other elicitations.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** Kept here (not imported from ask-mode) to avoid a cycle; keep wording aligned with ASK_TOOLS_UNAVAILABLE. */
const TOOLS_UNAVAILABLE_NOTE =
  "[pacer] pacer MCP tools were not reported for this Codex session. Answer only from the digest and conversation; do not invent tool results.";

/**
 * Features turned off for a digest/ask turn (verified as dotted `features.<name>=false` overrides
 * against codex-cli 0.167.2). `unified_exec` is intentionally omitted: on 0.167.2 it stays stable
 * true under `--disable` / `-c features.unified_exec=false`; ask mode relies on approval decline
 * plus the read-only sandbox (asserted from `thread/start`) instead.
 */
export const CODEX_ASK_FEATURES_OFF = [
  "hooks", "shell_tool", "view_image", "image_generation", "apps",
  "browser_use", "browser_use_external", "in_app_browser", "computer_use",
  "code_mode", "code_mode_host", "enable_mcp_apps",
  "multi_agent", "memories", "plugins",
] as const;

/** Config layer origins that thread config can override (Codex 0.167.2 `ConfigLayerSource`). */
export const CODEX_ASK_OVERRIDABLE_LAYERS = new Set([
  "user", "project", "sessionFlags", "packagedDefaults",
]);

/** Origin keys whose managed values would break ask-mode restrictions. */
const SENSITIVE_ORIGIN = /^(mcp_servers\.|features\.|web_search\b)/;

export const CODEX_PLAN_VERSION = 1 as const;

/** Host-issued Codex plan on the pinned command's stdin (no grant values). */
export interface CodexPlan {
  v: typeof CODEX_PLAN_VERSION;
  /** User / seeded question for turn/start. */
  prompt: string;
  /** Seeded transcript prompt when `session` cannot be resumed. */
  fallbackPrompt?: string;
  /** Stored Codex thread id. */
  session?: string;
  /** developerInstructions for thread/start (system + digest). */
  system: string;
  model?: string;
  mcpName: string;
  mcpCommand: string;
  mcpArgs: string[];
  /** Env keys already present on the child; copied into mcp_servers.pacer.env. */
  mcpEnvKeys: string[];
  /** When false, skip MCP and answer digest-only (caller already adjusted the system prompt). */
  tools: boolean;
  turnId?: string;
}

export interface CodexTurnResult {
  text: string;
  session?: string;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; coverage: "measured" | "partial" | "unknown" };
  tools: { tool: string; status: string }[];
  toolsHealthy: boolean;
  error?: string;
  deltas: string[];
}

export interface CodexTurnHooks {
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

const COMMAND_APPROVAL = "item/commandExecution/requestApproval";
const FILE_APPROVAL = "item/fileChange/requestApproval";
const MCP_ELICITATION = "mcpServer/elicitation/request";
const PERMISSIONS_APPROVAL = "item/permissions/requestApproval";
const USER_INPUT = "item/tool/requestUserInput";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function layerType(origin: unknown): string | null {
  if (!isRecord(origin)) return null;
  const name = origin.name;
  return isRecord(name) && typeof name.type === "string" ? name.type : null;
}

/** True when this elicitation is Codex's MCP tool-call approval form (Orca's test). */
export function isCodexMcpToolApproval(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const meta = isRecord(params._meta) ? params._meta : {};
  if (meta.codex_approval_kind !== "mcp_tool_call") return false;
  if (params.mode !== undefined && params.mode !== "form") return false;
  const schema = params.requestedSchema;
  if (schema === undefined || schema === null) return true;
  if (!isRecord(schema) || schema.type !== "object") return false;
  const properties = schema.properties;
  return isRecord(properties) && Object.keys(properties).length === 0;
}

/** Parse the host-issued Codex plan from pinned stdin. */
export function parseCodexPlan(stdin: string): CodexPlan | null {
  try {
    const plan = JSON.parse(stdin) as CodexPlan;
    if (plan?.v !== CODEX_PLAN_VERSION || typeof plan.prompt !== "string" || typeof plan.system !== "string") return null;
    if (typeof plan.mcpName !== "string" || typeof plan.mcpCommand !== "string") return null;
    if (!Array.isArray(plan.mcpArgs) || !Array.isArray(plan.mcpEnvKeys)) return null;
    return plan;
  } catch {
    return null;
  }
}

/** Env pairs for mcp_servers.pacer.env: only the plan's MCP keys from the issued turn env. */
export function codexMcpEnv(env: Record<string, string>, mcpEnvKeys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const key of mcpEnvKeys) {
    if (typeof env[key] === "string") out[key] = env[key]!;
  }
  return out;
}

/** Base thread config: plugins/web/search off, ask features off, optional pacer MCP. */
export function codexAskThreadConfig(plan: CodexPlan, env: Record<string, string>, mcpOff: Record<string, false>): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...Object.fromEntries(CODEX_ASK_FEATURES_OFF.map(f => [`features.${f}`, false])),
    "features.plugins": false,
    web_search: "disabled",
    ...mcpOff,
  };
  if (plan.tools) {
    const key = `mcp_servers.${plan.mcpName}`;
    config[`${key}.command`] = plan.mcpCommand;
    config[`${key}.args`] = plan.mcpArgs;
    const mcpEnv = codexMcpEnv(env, plan.mcpEnvKeys);
    if (Object.keys(mcpEnv).length) config[`${key}.env`] = mcpEnv;
    config[`${key}.enabled`] = true;
  }
  return config;
}

/**
 * Fail closed when any sensitive config origin is outside the overridable allow-list (mdm, system,
 * enterpriseManaged, legacy managed types, unknown). Returns `enabled=false` for every listed MCP
 * server name so thread config can disable them.
 */
export function codexMcpServersOff(response: unknown): Record<string, false> {
  if (!isRecord(response) || !isRecord(response.config) || !isRecord(response.origins)) {
    throw new Error("Codex config/read did not return config and origins");
  }
  const origins = response.origins as Record<string, unknown>;
  for (const [key, origin] of Object.entries(origins)) {
    if (!SENSITIVE_ORIGIN.test(key)) continue;
    const type = layerType(origin);
    if (!type || !CODEX_ASK_OVERRIDABLE_LAYERS.has(type)) {
      throw new Error(`Codex has a managed config layer (${type ?? "unknown"}) that cannot be overridden for ask mode`);
    }
  }
  const servers = response.config.mcp_servers ?? {};
  if (!isRecord(servers)) throw new Error("Codex config/read mcp_servers was not an object");
  const names = Object.keys(servers);
  if (names.some(name => !SERVER_NAME.test(name))) {
    throw new Error("Codex mcp_servers contains an invalid server name");
  }
  return Object.fromEntries(names.map(name => [`mcp_servers.${name}.enabled`, false as const]));
}

/** Healthy when pacer is connected and lists at least one tool. */
export function codexMcpHealthy(answer: unknown, mcpName: string): boolean {
  if (!isRecord(answer) || !Array.isArray(answer.data)) return false;
  const needle = mcpName.toLowerCase();
  for (const entry of answer.data) {
    if (!isRecord(entry) || String(entry.name ?? "").toLowerCase() !== needle) continue;
    if (entry.runtimeStatus !== "connected") return false;
    const tools = entry.tools;
    if (Array.isArray(tools)) return tools.length > 0;
    if (isRecord(tools)) return Object.keys(tools).length > 0;
    return false;
  }
  return false;
}

/**
 * Ask mode requires on-request approvals and a read-only sandbox. Live Codex still reports
 * `approvalPolicy: "on-request"` even when launched with `-a never` (thread settings win).
 */
export function assertCodexAskThreadGates(opened: unknown): void {
  if (!isRecord(opened)) throw new Error("Codex thread/start returned a non-object");
  const policy = opened.approvalPolicy ?? (isRecord(opened.thread) ? opened.thread.approvalPolicy : undefined);
  if (policy !== "on-request") {
    throw new Error(`Codex ask mode requires approvalPolicy on-request, got ${String(policy)}`);
  }
  const sandbox = opened.sandbox ?? (isRecord(opened.thread) ? opened.thread.sandbox : undefined);
  const ok = sandbox === "read-only"
    || sandbox === "readOnly"
    || (isRecord(sandbox) && (sandbox.type === "readOnly" || sandbox.type === "read-only"));
  if (!ok) throw new Error(`Codex ask mode requires a read-only sandbox, got ${JSON.stringify(sandbox)}`);
}

function readThreadId(opened: unknown): string | undefined {
  if (!isRecord(opened)) return undefined;
  if (isRecord(opened.thread) && typeof opened.thread.id === "string") return opened.thread.id;
  return typeof opened.threadId === "string" ? opened.threadId : undefined;
}

function readTurnId(reply: unknown): string | undefined {
  if (!isRecord(reply)) return undefined;
  if (isRecord(reply.turn) && typeof reply.turn.id === "string") return reply.turn.id;
  return typeof reply.turnId === "string" ? reply.turnId : undefined;
}

/**
 * Drive one Codex app-server session on an already-spawned child. Stdin/stdout are JSON-RPC;
 * resolves with the turn result JSON shape the plugin parses from spawn stdout.
 */
export async function runCodexTurn(
  child: ChildProcessWithoutNullStreams,
  plan: CodexPlan,
  env: Record<string, string>,
  hooks: CodexTurnHooks = {},
): Promise<CodexTurnResult> {
  const tools: CodexTurnResult["tools"] = [];
  const deltas: string[] = [];
  const textParts: string[] = [];
  let threadId = plan.session;
  /** Effective tools flag: flipped off when preflight is unhealthy so approvals deny pacer_*. */
  let toolsEnabled = plan.tools;
  let toolsHealthy = false;
  let error: string | undefined;
  let input = 0, output = 0, measured = false;
  let nextId = 1;
  let activeTurnId: string | undefined;
  /** Buffered status when turn/completed arrives before the waiter is registered (fast fixtures). */
  let earlyTurnStatus: string | undefined;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let turnDone: ((status: string) => void) | undefined;

  const send = (frame: Json) => {
    if (hooks.signal?.aborted) throw new Error("The turn was cancelled.");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  };
  const request = (method: string, params: Json) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const reply = (id: unknown, result: Json) => send({ id, result });

  const noteTool = (tool: string, status: string) => {
    if (tools.length < 64) tools.push({ tool, status });
  };

  const answerApproval = (method: string, params: unknown, id: unknown) => {
    if (method === COMMAND_APPROVAL) {
      noteTool("shell", "denied");
      reply(id, { decision: "decline" });
      return;
    }
    if (method === FILE_APPROVAL) {
      noteTool("write", "denied");
      reply(id, { decision: "decline" });
      return;
    }
    if (method === PERMISSIONS_APPROVAL) {
      noteTool("permissions", "denied");
      reply(id, { decision: "decline" });
      return;
    }
    if (method === USER_INPUT) {
      noteTool("user_input", "denied");
      send({ id, error: { code: -32000, message: "pacer ask mode does not answer tool user input" } });
      return;
    }
    if (method === MCP_ELICITATION) {
      const server = isRecord(params) ? String(params.serverName ?? "") : "";
      const allow = toolsEnabled && toolsHealthy && server.toLowerCase() === plan.mcpName.toLowerCase() && isCodexMcpToolApproval(params);
      noteTool(allow ? `pacer_${server || plan.mcpName}` : (server || "mcp"), allow ? "allowed" : "denied");
      if (allow) reply(id, { action: "accept", content: null, _meta: null });
      else reply(id, { action: "decline", content: null, _meta: null });
      return;
    }
    // Fail closed on unrecognized server requests.
    send({ id, error: { code: -32601, message: `unsupported server request: ${method}` } });
  };

  const onLine = (line: string) => {
    let msg: Json;
    try { msg = JSON.parse(line) as Json; } catch { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const wait = pending.get(msg.id as number);
      if (!wait) return;
      pending.delete(msg.id as number);
      if (msg.error) wait.reject(msg.error);
      else wait.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string" && msg.id !== undefined) {
      answerApproval(msg.method, msg.params, msg.id);
      return;
    }
    if (msg.method === "item/agentMessage/delta") {
      const delta = String((msg.params as Json)?.delta ?? "");
      if (delta) { textParts.push(delta); deltas.push(delta); hooks.onDelta?.(delta); }
      return;
    }
    if (msg.method === "item/started" || msg.method === "item/completed") {
      const item = isRecord((msg.params as Json)?.item) ? (msg.params as Json).item as Json : null;
      if (item) {
        const type = String(item.type ?? "");
        if (type === "mcpToolCall" || type === "mcp_tool_call") {
          const server = String(item.server ?? item.serverName ?? "");
          const tool = String(item.tool ?? item.toolName ?? "tool");
          const name = server ? `${server}_${tool}` : tool;
          const status = msg.method === "item/started" ? "pending"
            : item.error || item.status === "failed" ? "error" : "completed";
          noteTool(name, status);
        } else if (type === "webSearch" || type === "web_search_call") {
          noteTool("webfetch", msg.method === "item/started" ? "pending" : "completed");
        } else if (type === "commandExecution" || type === "local_shell_call") {
          noteTool("shell", msg.method === "item/started" ? "pending" : String(item.status ?? "completed"));
        } else if (type === "fileChange" || type === "apply_patch") {
          noteTool("write", msg.method === "item/started" ? "pending" : String(item.status ?? "completed"));
        }
      }
      return;
    }
    if (msg.method === "turn/completed") {
      const turn = isRecord((msg.params as Json)?.turn) ? (msg.params as Json).turn as Json : null;
      const id = turn && typeof turn.id === "string" ? turn.id : undefined;
      if (id && activeTurnId && id !== activeTurnId) return;
      const status = turn && typeof turn.status === "string" ? turn.status : "completed";
      if (turn && isRecord(turn.tokenUsage)) {
        const u = turn.tokenUsage;
        if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
          input = u.inputTokens; output = u.outputTokens; measured = true;
        }
      }
      if (turnDone) turnDone(status);
      else earlyTurnStatus = status;
      return;
    }
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", onLine);
  child.stderr?.resume();

  const interrupt = async () => {
    if (threadId && activeTurnId) {
      try { await request("turn/interrupt", { threadId, turnId: activeTurnId }); } catch { /* terminate below */ }
    }
  };

  const abort = () => {
    void interrupt().finally(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      for (const [, w] of pending) w.reject(new Error("The turn was cancelled."));
      pending.clear();
      turnDone?.("interrupted");
    });
  };
  hooks.signal?.addEventListener("abort", abort, { once: true });

  try {
    await request("initialize", {
      clientInfo: { name: "pacer-assistant", version: "1" },
      capabilities: {},
    });
    send({ method: "initialized" });

    const cwd = env.PWD || process.cwd();
    let mcpOff: Record<string, false> = {};
    try {
      const cfg = await request("config/read", { cwd });
      mcpOff = codexMcpServersOff(cfg);
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "Codex config/read failed for ask mode");
    }

    const threadSettingsFor = (attachMcp: boolean) => {
      const effective: CodexPlan = attachMcp ? { ...plan, tools: true } : { ...plan, tools: false };
      return {
        cwd,
        approvalPolicy: "on-request" as const,
        sandbox: "read-only" as const,
        approvalsReviewer: "user" as const,
        config: codexAskThreadConfig(effective, env, mcpOff),
        ...(plan.model ? { model: plan.model } : {}),
        developerInstructions: plan.system,
      };
    };

    let promptBody = plan.prompt;
    if (plan.session) {
      try {
        const resumed = await request("thread/resume", {
          threadId: plan.session, ...threadSettingsFor(toolsEnabled), excludeTurns: true,
        });
        assertCodexAskThreadGates(resumed);
        threadId = plan.session;
      } catch (e) {
        // Gate failures must abort; only a missing/unresumable thread falls back to a fresh start.
        if (e instanceof Error && /approvalPolicy|read-only sandbox/.test(e.message)) throw e;
        threadId = undefined;
        if (plan.fallbackPrompt) promptBody = plan.fallbackPrompt;
      }
    }
    if (!threadId) {
      const opened = await request("thread/start", threadSettingsFor(toolsEnabled));
      assertCodexAskThreadGates(opened);
      threadId = readThreadId(opened);
    }
    if (!threadId) throw new Error("codex app-server returned no thread id");

    if (toolsEnabled) {
      try {
        const status = await request("mcpServerStatus/list", {
          threadId, detail: "toolsAndAuthOnly", serverName: plan.mcpName,
        });
        toolsHealthy = codexMcpHealthy(status, plan.mcpName);
      } catch {
        toolsHealthy = false;
      }
    }

    const preflightHealthy = toolsEnabled && toolsHealthy;
    toolsHealthy = preflightHealthy;
    // Unhealthy preflight: digest-only — drop MCP+grant from a replacement thread so the prompt
    // never runs on a session that still holds the grant (same principle as ACP b310c20ec).
    if (toolsEnabled && !preflightHealthy) {
      toolsEnabled = false;
      error = error ?? "pacer MCP tools were not reported on the Codex session; answering from the digest only";
      const replacement = await request("thread/start", threadSettingsFor(false));
      assertCodexAskThreadGates(replacement);
      const digestThreadId = readThreadId(replacement);
      if (!digestThreadId) throw new Error("codex app-server returned no digest-only thread id");
      threadId = digestThreadId;
    }
    const promptText = plan.tools && !preflightHealthy
      ? `${TOOLS_UNAVAILABLE_NOTE}\n\n${promptBody}`
      : promptBody;

    const started = await request("turn/start", {
      threadId,
      input: [{ type: "text", text: promptText }],
    });
    activeTurnId = readTurnId(started);
    if (!activeTurnId) throw new Error("codex app-server returned no turn id");

    const status = await new Promise<string>((resolve, reject) => {
      if (earlyTurnStatus !== undefined) {
        resolve(earlyTurnStatus);
        return;
      }
      turnDone = resolve;
      hooks.signal?.addEventListener("abort", () => reject(new Error("The turn was cancelled.")), { once: true });
    });
    if (status === "failed" || status === "interrupted") {
      error = error ?? (status === "interrupted" ? "The turn was cancelled." : "The Codex turn failed.");
    }

    return {
      text: textParts.join(""),
      session: threadId,
      usage: { input, output, coverage: measured ? "measured" : "unknown" },
      tools: tools.slice(0, 64),
      toolsHealthy: preflightHealthy,
      ...(error ? { error } : {}),
      deltas,
    };
  } catch (e) {
    const message = e && typeof e === "object" && "message" in e ? String((e as Error).message) : String(e);
    return {
      text: textParts.join(""),
      ...(threadId ? { session: threadId } : {}),
      usage: { input, output, coverage: measured ? "measured" : "unknown" },
      tools: tools.slice(0, 64),
      toolsHealthy,
      error: message,
      deltas,
    };
  } finally {
    hooks.signal?.removeEventListener("abort", abort);
    rl.close();
    try { child.stdin.end(); } catch { /* ignore */ }
  }
}
