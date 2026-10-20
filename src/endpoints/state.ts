import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Ctx } from "../types";

export interface EndpointState { state: "ready" | "not_tested" | "not_working" | "key_missing"; detail?: string; checked_at?: string }
function states(ctx: Ctx): Record<string, EndpointState> {
  try {
    const value = JSON.parse(readFileSync(join(ctx.pacerHome, "endpoints", "state.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    for (const entry of Object.values(value) as EndpointState[]) {
      if (!entry || !["ready", "not_tested", "not_working", "key_missing"].includes(entry.state) || (entry.detail !== undefined && typeof entry.detail !== "string") || (entry.checked_at !== undefined && typeof entry.checked_at !== "string")) throw Error();
    }
    return value;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw Error("endpoint state read failed");
  }
}
export function readEndpointState(ctx: Ctx, name: string): EndpointState {
  return states(ctx)[name] ?? {state: "not_tested"};
}
export function writeEndpointState(ctx: Ctx, name: string, state: EndpointState): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw Error("invalid endpoint name");
  const value = {...states(ctx), [name]: state};
  const dir = join(ctx.pacerHome, "endpoints"), path = join(dir, "state.json"), temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dir, {recursive: true, mode: 0o700}); chmodSync(dir, 0o700);
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {flag: "wx", mode: 0o600});
    renameSync(temp, path);
  } finally { rmSync(temp, {force: true}); }
}

function redactSecrets(text: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
  return text.replace(/authorization\s*[:=]\s*[^\r\n]*/gi, "Authorization: [redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|api[_-]?key|token)[_-][A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}

/**
 * One-line form for stored or displayed details (test failures, check results,
 * executor reasons). Redact before selecting a line so multiline credentials
 * cannot leak fragments.
 */
export function redactEndpointError(text: string, secrets: string[] = []): string {
  return redactSecrets(text, secrets).split(/\r?\n/)[0].slice(0, 500);
}

/**
 * Full form for an error returned to the person who made the request, such as
 * a strategy validation error whose reasons follow its first line.
 */
export function redactEndpointMessage(text: string, secrets: string[] = []): string {
  return redactSecrets(text, secrets).slice(0, 4000);
}
