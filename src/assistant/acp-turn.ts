/**
 * One opencode ACP ask-mode turn (spec §3): JSON-RPC over the child's stdio. The host runs this
 * inside the plugin-owned `capability.process.spawn` (mode `acp`) so the per-turn grant stays in
 * the resolved environment and never reaches the plugin. Permission requests are answered here
 * fail-closed: allow only tools of the pacer MCP server, deny everything else.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** Kept here (not imported from ask-mode) to avoid a cycle; keep wording aligned with ASK_TOOLS_UNAVAILABLE. */
const TOOLS_UNAVAILABLE_NOTE = "[pacer] pacer MCP tools were not reported for this ACP session. Answer only from the digest and conversation; do not invent tool results.";

/**
 * When the agent publishes no `mcpTools` list, confirm the same mcpServers entry answers
 * `tools/list` with a pacer tool (fail closed on timeout/error/empty).
 */
async function mcpToolsListHealthy(plan: AcpPlan, env: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
  if (!plan.tools) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const child = nodeSpawn(plan.mcpCommand, plan.mcpArgs, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ }; done(false); }, 3_000);
    timer.unref();
    signal?.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch { /* ignore */ }; done(false); }, { once: true });
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name?: string }[] } };
          if (msg.id === 2 && Array.isArray(msg.result?.tools)) {
            clearTimeout(timer);
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
            const ok = msg.result!.tools!.some(t => {
              const n = String(t.name ?? "").toLowerCase();
              return n.startsWith("pacer") || n.includes("pacer_");
            });
            done(ok);
            return;
          }
        } catch { /* ignore */ }
      }
    });
    child.on("error", () => { clearTimeout(timer); done(false); });
    child.on("exit", () => { clearTimeout(timer); done(false); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pacer-acp-health", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}

export const ACP_PLAN_VERSION = 1 as const;

/** Host-issued ACP plan on the pinned command's stdin (no grant values). */
export interface AcpPlan {
  v: typeof ACP_PLAN_VERSION;
  prompt: string;
  /** Seeded transcript prompt when `session` cannot be loaded. */
  fallbackPrompt?: string;
  session?: string;
  model?: string;
  /** MCP server name as passed in session/new (tools are reported as `{name}_{tool}`). */
  mcpName: string;
  mcpCommand: string;
  mcpArgs: string[];
  /** Env keys already present on the opencode child; copied into mcpServers[].env. */
  mcpEnvKeys: string[];
  /** When false, skip MCP and answer digest-only (caller already adjusted the system prompt). */
  tools: boolean;
  turnId?: string;
}

export interface AcpTurnResult {
  text: string;
  session?: string;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; coverage: "measured" | "partial" | "unknown" };
  tools: { tool: string; status: string }[];
  /** Whether the agent's own reporting showed pacer MCP tools before the user prompt. */
  toolsHealthy: boolean;
  error?: string;
  deltas: string[];
}

export interface AcpTurnHooks {
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

function settle(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return Promise.race([
    new Promise<void>(r => setTimeout(r, ms)),
    new Promise<void>(r => signal?.addEventListener("abort", () => r(), { once: true })),
  ]);
}

/** Read MCP tool health from an ACP session result `_meta` (agent reporting). Fail closed. */
/** Agent MCP surface: healthy / explicitly unhealthy / silent (try tools/list). */
function mcpHealthFromMeta(meta: Json | undefined, mcpName: string): "healthy" | "unhealthy" | "silent" {
  if (!meta) return "silent";
  if (meta.mcpHealthy === false || meta.mcpError) return "unhealthy";
  const listed = meta.mcpTools ?? meta["opencode/mcpTools"];
  if (listed === undefined) return "silent";
  if (!Array.isArray(listed) || !listed.length) return "unhealthy";
  const needle = mcpName.toLowerCase();
  const ok = listed.some(t => {
    const name = String(t).toLowerCase();
    return name.includes("pacer") || name.includes(needle) || name.startsWith(`${needle}_`);
  });
  return ok ? "healthy" : "unhealthy";
}

/** True only when the tool identity (title) is a pacer MCP tool — never match on arguments. */
function isPacerTool(mcpName: string, title: string): boolean {
  const t = title.toLowerCase();
  const prefix = `${mcpName}_`.toLowerCase();
  return t.startsWith(prefix) || t.startsWith("pacer_") || t.startsWith("pacer-");
}

/** `assistant.reply` tools[].tool is max 128; opencode may put the whole shell command in the title. */
function toolTitle(title: string): string {
  return title.length <= 128 ? title : `${title.slice(0, 125)}...`;
}

function optionId(options: { optionId?: string; kind?: string }[], prefer: "allow" | "reject"): string | null {
  const allow = options.find(o => o.kind === "allow_once" || o.optionId === "once" || o.kind === "allow_always");
  const reject = options.find(o => o.kind === "reject_once" || o.optionId === "reject" || o.kind === "reject_always");
  if (prefer === "allow") return allow?.optionId ?? null;
  return reject?.optionId ?? options.find(o => String(o.kind ?? "").startsWith("reject"))?.optionId ?? null;
}

/** Parse the host-issued ACP plan from pinned stdin. */
export function parseAcpPlan(stdin: string): AcpPlan | null {
  try {
    const plan = JSON.parse(stdin) as AcpPlan;
    if (plan?.v !== ACP_PLAN_VERSION || typeof plan.prompt !== "string" || typeof plan.mcpName !== "string") return null;
    if (typeof plan.mcpCommand !== "string" || !Array.isArray(plan.mcpArgs) || !Array.isArray(plan.mcpEnvKeys)) return null;
    return plan;
  } catch {
    return null;
  }
}

/**
 * Drive one ACP session on an already-spawned `opencode acp` child. Stdin/stdout are the ACP
 * transport; stderr is ignored except for abort. Resolves with the turn result JSON shape the
 * plugin parses from spawn stdout.
 */
export async function runAcpTurn(
  child: ChildProcessWithoutNullStreams,
  plan: AcpPlan,
  env: Record<string, string>,
  hooks: AcpTurnHooks = {},
): Promise<AcpTurnResult> {
  const tools: AcpTurnResult["tools"] = [];
  const deltas: string[] = [];
  const textParts: string[] = [];
  let sessionId = plan.session;
  /** Pre-prompt MCP health only; frozen before session/prompt so mid-turn events cannot reopen tools. */
  let toolsHealthy = false;
  let healthLocked = false;
  /** Ignore agent text until session/prompt: resume/load can replay earlier turns as chunks. */
  let captureText = false;
  let error: string | undefined;
  let input = 0, output = 0, measured = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

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
  const notePreflightHealth = (meta: Json | undefined) => {
    if (healthLocked) return;
    const h = mcpHealthFromMeta(meta, plan.mcpName);
    if (h === "healthy") toolsHealthy = true;
    else if (h === "unhealthy") toolsHealthy = false;
  };

  const mcpServers = plan.tools
    ? [{
        name: plan.mcpName,
        command: plan.mcpCommand,
        args: plan.mcpArgs,
        env: plan.mcpEnvKeys
          .filter(k => typeof env[k] === "string")
          .map(name => ({ name, value: env[name]! })),
      }]
    : [];

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
    if (msg.method === "session/update") {
      const update = ((msg.params as Json)?.update ?? {}) as Json;
      const kind = update.sessionUpdate;
      if (kind === "agent_message_chunk" && (update.content as Json)?.type === "text") {
        const t = String((update.content as Json).text ?? "");
        if (t && captureText) { textParts.push(t); deltas.push(t); hooks.onDelta?.(t); }
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        const title = toolTitle(String(update.title ?? update.toolCallId ?? "tool"));
        const status = String(update.status ?? (kind === "tool_call" ? "pending" : "")).slice(0, 32);
        if (status) tools.push({ tool: title, status });
        // Never promote preflight health from mid-turn tool events.
      }
      // Agent-reported MCP tool surface before the prompt may set health; after lock, ignore.
      notePreflightHealth(update._meta as Json | undefined);
      return;
    }
    if (msg.method === "session/request_permission") {
      const toolCall = ((msg.params as Json)?.toolCall ?? {}) as Json;
      const title = toolTitle(String(toolCall.title ?? ""));
      const options = ((msg.params as Json)?.options ?? []) as { optionId?: string; kind?: string }[];
      // Digest-only turns (health failed or tools off) deny every permission request.
      const allow = plan.tools && toolsHealthy && isPacerTool(plan.mcpName, title);
      const id = optionId(options, allow ? "allow" : "reject");
      tools.push({ tool: title || "permission", status: allow ? "allowed" : "denied" });
      if (!id) {
        reply(msg.id, { outcome: { outcome: "rejected" } });
        return;
      }
      reply(msg.id, { outcome: { outcome: "selected", optionId: id } });
      return;
    }
    if (msg.method && msg.id !== undefined) reply(msg.id, {});
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", onLine);
  child.stderr?.resume();

  const abort = () => {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    for (const [, w] of pending) w.reject(new Error("The turn was cancelled."));
    pending.clear();
  };
  hooks.signal?.addEventListener("abort", abort, { once: true });

  try {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "pacer-assistant", version: "1" },
    });

    const cwd = env.PWD || process.cwd();
    let promptBody = plan.prompt;
    if (plan.session) {
      try {
        await request("session/load", { sessionId: plan.session, cwd, mcpServers });
        sessionId = plan.session;
      } catch {
        // Resume failed: fall through to session/new with the seeded fallback prompt when present.
        sessionId = undefined;
        if (plan.fallbackPrompt) promptBody = plan.fallbackPrompt;
      }
    }
    if (!sessionId) {
      const created = await request("session/new", { cwd, mcpServers }) as { sessionId?: string; _meta?: Json };
      sessionId = created?.sessionId;
      if (plan.tools && mcpServers.length > 0) {
        const reported = mcpHealthFromMeta(created?._meta, plan.mcpName);
        if (reported === "healthy") toolsHealthy = true;
        else if (reported === "unhealthy") toolsHealthy = false;
        else {
          await settle(hooks.signal, 400);
          // Agent silent on mcpTools: confirm the same MCP entry lists pacer tools (fail closed).
          if (!toolsHealthy) toolsHealthy = await mcpToolsListHealthy(plan, env, hooks.signal);
        }
      }
    } else if (plan.tools && mcpServers.length > 0 && !toolsHealthy) {
      // Resume: agent usually silent on load; only probe when health was never confirmed (not when meta said unhealthy).
      await settle(hooks.signal, 400);
      if (!toolsHealthy) toolsHealthy = await mcpToolsListHealthy(plan, env, hooks.signal);
    }
    if (!sessionId) throw new Error("opencode ACP returned no session id");

    // Freeze health before the prompt: mid-turn tool_call / permission frames must not reopen tools.
    healthLocked = true;
    const preflightHealthy = plan.tools && toolsHealthy;
    toolsHealthy = preflightHealthy;

    // When tools were requested but the agent reported none, continue digest-only for this turn.
    if (plan.tools && !preflightHealthy) {
      error = error ?? "pacer MCP tools were not reported on the ACP session; answering from the digest only";
    }
    const promptText = plan.tools && !preflightHealthy
      ? `${TOOLS_UNAVAILABLE_NOTE}\n\n${promptBody}`
      : promptBody;

    // opencode 2.2.3 ACP: model is a session config option (`session/set_config_option`).
    // `session/set_model` / camelCase variants are not implemented; silently ignoring leaves the
    // agent's free default (e.g. tidepool-alpha-free) and burns into provider.free-limit.
    if (plan.model) {
      const set = await request("session/set_config_option", {
        sessionId, configId: "model", value: plan.model,
      }) as { configOptions?: { id?: string; currentValue?: string }[] };
      const current = set?.configOptions?.find(o => o.id === "model")?.currentValue;
      if (current !== plan.model) {
        throw new Error(`opencode ACP model is ${current ?? "unset"}, wanted ${plan.model}`);
      }
    }

    captureText = true;
    const promptResult = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    }) as { stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number } };

    if (promptResult?.usage) {
      if (typeof promptResult.usage.inputTokens === "number" && typeof promptResult.usage.outputTokens === "number") {
        input = promptResult.usage.inputTokens;
        output = promptResult.usage.outputTokens;
        measured = true;
      }
    }

    return {
      text: textParts.join(""),
      ...(sessionId ? { session: sessionId } : {}),
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
      ...(sessionId ? { session: sessionId } : {}),
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
