import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../src/types";
import { shutdownPlugins } from "../src/plugins";
import { findRateLimits } from "../src/usage/codex";
import { fakeCtx as baseCtx } from "./helpers";

const fixtures: { ctx: Ctx; server: ReturnType<typeof Bun.serve> }[] = [];
/** Actual pinned provider children bridge only fixed synthetic argv to test callbacks. */
export function fakeCtx(options: Partial<Ctx> = {}): Ctx {
  const ctx = baseCtx(options);
  // Capture only the explicit synthetic callback; later ctx.run changes (SSH fixtures) never become provider execution.
  const fixtureRun = ctx.run;
  const token = crypto.randomUUID();
  const commands: Record<string, string[]> = {
    arkcli: ["usage", "plan", "--product", "coding-plan"],
    opencode: ["stats", "--models", "--cost", "--json", "--days", "7"],
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== `/${token}` || request.method !== "POST") return new Response("refused", { status: 403 });
    const { command, args } = await request.json() as { command: string; args: string[] };
    if (!Object.hasOwn(commands, command) || JSON.stringify(args) !== JSON.stringify(commands[command])) return new Response("refused", { status: 403 });
    return Response.json(await fixtureRun([command, ...args], command === "arkcli" ? 8000 : 15000));
  } });
  const bin = mkdtempSync(join(ctx.home, "usage-provider-fixtures-"));
  for (const command of Object.keys(commands)) writeFileSync(join(bin, command), `#!${process.execPath}\nconst r=await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/${token}`)},{method:'POST',body:JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2)})});\nif(!r.ok)process.exit(125);const v=await r.json();process.stdout.write(v.stdout);process.stderr.write(v.stderr);process.exit(v.code);\n`, { mode: 0o700 });
  const which = ctx.which;
  ctx.which = name => Object.hasOwn(commands, name) ? join(bin, name) : which(name);
  fixtures.push({ ctx, server });
  return ctx;
}
export async function cleanupUsageFixtures() {
  for (const fixture of fixtures.splice(0)) {
    try { await shutdownPlugins(fixture.ctx); } finally { await fixture.server.stop(true); }
  }
}
/** Test-only full tail oracle; production exports contain no local file reader. */
export async function lastRateLimits(path: string): Promise<Record<string, unknown> | null> {
  const file = Bun.file(path), text = await file.slice(Math.max(0, file.size - 4_000_000)).text();
  for (const line of text.split("\n").slice(0, -1).reverse()) {
    try { const found = findRateLimits(JSON.parse(line)); if (found) return found; } catch { /* Corrupt/incomplete fixture line. */ }
  }
  return null;
}
