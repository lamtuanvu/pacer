import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentSessionLaunch } from "@pacer/plugin";
import { loadStrategy } from "../config/strategy";
import { resolveRunner } from "../config/runner-id";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { pluginRegistry } from "./index";

const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024;
type Config = { source: string; value: Record<string, unknown>; plugins: string[] };

export function bundledAgentSessionSnapshot(ctx: Ctx): { version: string; pid: number | null } {
  const adapter = pluginRegistry(ctx).list(ctx).find(item => item.id === "pacer-agent-session");
  if (!adapter?.bundled || !adapter.enabled || adapter.publisher !== "pacer" ||
    !adapter.contributes.includes("agentSession"))
    throw new CoreError("plugin_unavailable", "bundled agent-session adapter is required");
  return { version: adapter.version, pid: adapter.pid };
}

/** Parse before native session creation so malformed account config has no external effect. */
export function validateOwnedOpenCodeConfig(env: Record<string, string | undefined>): Config {
  const source = env.OPENCODE_CONFIG_CONTENT ?? "{}";
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES)
    throw new CoreError("invalid_input", "OpenCode config exceeds the owned launch limit");
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new CoreError("invalid_input", "Invalid OPENCODE_CONFIG_CONTENT: expected a JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CoreError("invalid_input", "Invalid OPENCODE_CONFIG_CONTENT: expected a JSON object");
  const object = value as Record<string, unknown>, plugins = object.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.some(item => typeof item !== "string"))
    throw new CoreError("invalid_input", "Invalid OPENCODE_CONFIG_CONTENT.plugins: expected strings");
  return { source, value: object, plugins };
}

/** Only a selected local OpenCode runner and the canonical bundled adapter may issue this private source. */
export function planOwnedOpenCodeReporting(ctx: Ctx, executor: string, nativeId: string, dir: string,
  launch: AgentSessionLaunch, env: Record<string, string | undefined>, config: Config) {
  const runner = resolveRunner(loadStrategy(ctx), executor);
  bundledAgentSessionSnapshot(ctx);
  const reporting = launch.reporting;
  if (!runner || runner.id !== executor || runner.agent !== "opencode" || runner.host !== null ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(nativeId) ||
    !reporting || reporting.configEnv !== "OPENCODE_CONFIG_CONTENT" ||
    reporting.configKey !== "plugins" || env.OPENCODE_CONFIG_CONTENT !== config.source &&
      !(env.OPENCODE_CONFIG_CONTENT === undefined && config.source === "{}"))
    throw new CoreError("plugin_refused", "bundled OpenCode reporting plan changed owner");
  const source = reporting.source;
  if (!source.includes(`const sessionID = ${JSON.stringify(nativeId)};`) ||
    !source.includes(`const dir = ${JSON.stringify(dir)};`) ||
    Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES)
    throw new CoreError("plugin_refused", "OpenCode reporting source changed identity or exceeded the limit");
  const folder = join(dir, "report-plugin");
  const content = JSON.stringify({ ...config.value, plugins: [...new Set([...config.plugins, folder])] });
  if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES)
    throw new CoreError("invalid_input", "OpenCode launch config exceeds the owned limit");
  return { env: { ...env, OPENCODE_CONFIG_CONTENT: content }, file: {
    name: "opencode-report-plugin" as const, content: source, mode: 0o600,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  } };
}
