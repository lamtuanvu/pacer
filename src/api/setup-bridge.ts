import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNERS } from "../config/strategy";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type { OpDeps } from "./ops";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Native strategy.build, executor.setup.candidates and setup.init: Core renders live status, opens the strategy terminal
 * from the prompt file Rust wrote (never a caller-supplied command), probes the fixed local model servers through the
 * endpoint plugin and asks the Ollama server at OLLAMA_HOST for its first model with the same fetch `pacer init` uses. */
export async function setupEffectsBridge(ctx: Ctx, request: unknown, deps: OpDeps = {}): Promise<unknown> {
  const r = request && typeof request === "object" && !Array.isArray(request) ? request as Record<string, unknown> : {};
  if (r.kind === "status_text") {
    const [{ loadStrategy }, { computeStatus }, { renderText }] = await Promise.all([import("../config/strategy"), import("../engine/status"), import("../render/text")]);
    return { text: renderText(await computeStatus(ctx, loadStrategy(ctx))) };
  }
  if (r.kind === "strategy_terminal" && typeof r.agent === "string" && (PLANNERS as readonly string[]).includes(r.agent)
    && typeof r.id === "string" && ID.test(r.id) && (r.worktree === undefined || typeof r.worktree === "string")
    && (r.requestId === undefined || typeof r.requestId === "string" && ID.test(r.requestId))) {
    const [{ strategyArgv }, { withWork }, { openInTerminal }] = await Promise.all([import("../strategy/launcher"), import("../update/desktop/admission"), import("../terminal/open")]);
    const requestId = r.requestId as string | undefined;
    const options = { argv: strategyArgv(r.agent, readFileSync(join(ctx.pacerHome, "link", "sessions", `${r.id}.md`), "utf8")),
      title: "pacer strategy", worktree: r.worktree as string | undefined, requestId };
    const open = deps.openTerminal ?? deps.openInTerminal ?? openInTerminal;
    return withWork(ctx, { kind: "operation", id: "strategy-build", label: "Opening strategy planning session" },
      () => open(ctx, r.builtin === true ? { ...options, target: "builtin", requestId } : options));
  }
  if (r.kind === "ollama_model" && Object.keys(r).length === 1) {
    const { ollamaModel } = await import("../install/init");
    return { model: await ollamaModel(ctx) };
  }
  if (r.kind === "discover" && Array.isArray(r.baseUrls)) {
    const [{ discoverEndpointModels }, { localServers }] = await Promise.all([import("../plugins/endpoint-adapter"), import("../endpoints/detect")]);
    const allowed = new Set(localServers(ctx).map(s => s.base_url));
    if (!r.baseUrls.every(url => typeof url === "string" && allowed.has(url))) throw new CoreError("invalid_input", "setup effect required");
    return { results: await Promise.all((r.baseUrls as string[]).map(baseUrl => discoverEndpointModels(ctx, { baseUrl, key: null, timeoutMs: 1000 })
      .catch((error: unknown) => ({ failure: error instanceof Error ? error.message : String(error) })))) };
  }
  throw new CoreError("invalid_input", "setup effect required");
}
