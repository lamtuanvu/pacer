import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadStrategy, type Strategy } from "../config/strategy";
import type { Ctx } from "../types";

export function endpointKeyEnv(name: string): string {
  return `PACER_KEY_${name.toUpperCase().replaceAll("-", "_")}`;
}
interface OpencodeProvider {
  npm: string;
  name: string;
  options: {baseURL: string; apiKey?: string};
  models: Record<string, {name: string; limit: {context: number; output: number}; tool_call: boolean}>;
}
export function renderOpencodeConfig(strategy: Strategy): {$schema: string; provider: Record<string, OpencodeProvider>} {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: Object.fromEntries(Object.entries(strategy.accounts).filter(([, a]) => a.connection).map(([name, account]) => {
      const c = account.connection!;
      return [`pacer-${name}`, {
        npm: "@ai-sdk/openai-compatible", name: `${name} (pacer)`,
        options: {baseURL: c.base_url, ...(c.key === "none" ? {} : {apiKey: `{env:${endpointKeyEnv(name)}}`})},
        models: Object.fromEntries(c.models.map(m => [m.id, {name: m.name ?? m.id, limit: {context: m.context, output: m.output}, tool_call: m.tools}])),
      }];
    })),
  };
}
/** Compare contents as well as existence so external strategy edits cannot leave stale providers. */
export function writeOpencodeConfig(ctx: Ctx): string {
  const text = JSON.stringify(renderOpencodeConfig(loadStrategy(ctx)), null, 2) + "\n";
  const dir = join(ctx.pacerHome, "opencode"), path = join(dir, "opencode.json");
  mkdirSync(dir, {recursive: true, mode: 0o700}); chmodSync(dir, 0o700);
  try {
    if (readFileSync(path, "utf8") === text) { chmodSync(path, 0o600); return path; }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, {flag: "wx", mode: 0o600});
    renameSync(temp, path);
  } finally { rmSync(temp, {force: true}); }
  return path;
}
