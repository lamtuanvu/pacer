import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import type { Ctx } from "../types";

export const DEFAULT_PORT = 4317;

export function ensureToken(ctx: Ctx): string {
  const p = join(ctx.pacerHome, "token");
  if (existsSync(p)) {
    const t = readFileSync(p, "utf8").trim();
    if (t) return t;
  }
  mkdirSync(ctx.pacerHome, { recursive: true });
  const t = randomBytes(24).toString("hex");
  writeFileSync(p, `${t}\n`, { mode: 0o600 });
  return t;
}

/** Localhost-only, token-protected status endpoint (the phase-2 Orca plugin's transport 1). */
export function startServer(
  getCtx: () => Ctx, opts: { port?: number; sseIntervalMs?: number } = {},
): { port: number; token: string; stop: () => void } {
  const token = ensureToken(getCtx());
  const interval = opts.sseIntervalMs ?? 15_000;
  const status = async () => {
    const ctx = getCtx();
    return computeStatus(ctx, loadStrategy(ctx));
  };
  const enc = new TextEncoder();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? DEFAULT_PORT,
    idleTimeout: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized\n", { status: 401 });
      if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
      const { pathname } = new URL(req.url);
      if (pathname === "/state") {
        try {
          return Response.json(await status());
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }
      }
      if (pathname === "/events") {
        let timer: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = async () => {
              let envelope: { v: 1; type: "budget"; data: Awaited<ReturnType<typeof status>> } | { v: 1; type: "alert"; data: { error: string } };
              try {
                envelope = { v: 1, type: "budget", data: await status() };
              } catch (e) {
                envelope = { v: 1, type: "alert", data: { error: (e as Error).message } };
              }
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(envelope)}\n\n`));
              } catch {
                clearInterval(timer);
              }
            };
            await send();
            timer = setInterval(send, interval);
          },
          cancel() {
            clearInterval(timer);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
      return new Response("not found\n", { status: 404 });
    },
  });
  return { port: server.port!, token, stop: () => server.stop(true) };
}
