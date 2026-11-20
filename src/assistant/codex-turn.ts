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

/** Features turned off for a digest/ask turn (Orca reply-only keys; verified as dotted config overrides). */
export const CODEX_ASK_FEATURES_OFF = [
  "hooks", "shell_tool", "unified_exec", "view_image", "image_generation", "apps",
  "browser_use", "in_app_browser", "computer_use", "multi_agent", "memories", "plugins",
] as const;

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

const LAYERS_OVER_THREAD = new Set(["legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm"]);
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
    const mcpEnv = Object.fromEntries(
      plan.mcpEnvKeys.filter(k => typeof env[k] === "string").map(name => [name, env[name]!]),
    );
    if (Object.keys(mcpEnv).length) config[`${key}.env`] = mcpEnv;
    config[`${key}.enabled`] = true;
  }
  return config;
}

/** `enabled=false` for every MCP server config/read lists; refuse when a managed layer re-enables one. */
export function codexMcpServersOff(response: unknown): Record<string, false> {
  if (!isRecord(response) || !isRecord(response.config) || !isRecord(response.origins)) {
    throw new Error("Codex config/read did not return config and origins");
  }
  const servers = response.config.mcp_servers ?? {};
  if (!isRecord(servers)) throw new Error("Codex config/read mcp_servers was not an object");
  const names = Object.keys(servers);
  const origins = response.origins as Record<string, unknown>;
  if (names.some(name => !SERVER_NAME.test(name) || LAYERS_OVER_THREAD.has(layerType(origins[`mcp_servers.${name}.enabled`]) ?? ""))) {
    throw new Error("Codex has a managed MCP server that cannot be disabled for ask mode");
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
  let toolsHealthy = false;
  let error: string | undefined;
  let input = 0, output = 0, measured = false;
  let nextId = 1;
  let activeTurnId: string | undefined;
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
      const allow = plan.tools && toolsHealthy && server.toLowerCase() === plan.mcpName.toLowerCase() && isCodexMcpToolApproval(params);
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
      turnDone?.(status);
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

    const threadConfig = codexAskThreadConfig(plan, env, mcpOff);
    const threadSettings = {
      cwd,
      approvalPolicy: "on-request" as const,
      sandbox: "read-only" as const,
      approvalsReviewer: "user" as const,
      config: threadConfig,
      ...(plan.model ? { model: plan.model } : {}),
      developerInstructions: plan.system,
    };

    let promptBody = plan.prompt;
    if (plan.session) {
      try {
        await request("thread/resume", { threadId: plan.session, ...threadSettings, excludeTurns: true });
        threadId = plan.session;
      } catch {
        threadId = undefined;
        if (plan.fallbackPrompt) promptBody = plan.fallbackPrompt;
      }
    }
    if (!threadId) {
      const opened = await request("thread/start", threadSettings);
      threadId = readThreadId(opened);
    }
    if (!threadId) throw new Error("codex app-server returned no thread id");

    if (plan.tools) {
      try {
        const status = await request("mcpServerStatus/list", {
          threadId, detail: "toolsAndAuthOnly", serverName: plan.mcpName,
        });
        toolsHealthy = codexMcpHealthy(status, plan.mcpName);
      } catch {
        toolsHealthy = false;
      }
    }

    const preflightHealthy = plan.tools && toolsHealthy;
    toolsHealthy = preflightHealthy;
    if (plan.tools && !preflightHealthy) {
      error = error ?? "pacer MCP tools were not reported on the Codex session; answering from the digest only";
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
