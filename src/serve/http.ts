import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import type { Ctx } from "../types";
import { toBudget } from "../link/budget";
import { currentSnapshot, refreshConsoleTerminals, readLatest, readOutboxSince } from "../link/store";
import { pumpOnce } from "../link/pump";

import { consoleOpener } from "./console-open";

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

/** Localhost-only, token-protected status endpoint and guarded console opener (the Orca plugin's HTTP transport). */
export function startServer(
  getCtx: () => Ctx, opts: { port?: number; sseIntervalMs?: number; tailMs?: number; pumpMs?: number } = {},
): { port: number; token: string; stop: () => void } {
  const token = ensureToken(getCtx());
  const interval = opts.sseIntervalMs ?? 15_000;
  const tailMs = opts.tailMs ?? 1_000;
  const pumpMs = opts.pumpMs ?? 15_000;
  const status = async () => {
    const ctx = getCtx();
    return computeStatus(ctx, loadStrategy(ctx));
  };
  const enc = new TextEncoder();
  const openConsole = consoleOpener();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? DEFAULT_PORT,
    idleTimeout: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const headers = { "X-Pacer": "1" };
      if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true }, { headers });
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized\n", { status: 401 });
      if (req.method === "POST" && ["/console/open", "/console/forget"].includes(pathname)) return openConsole(req, getCtx());
      if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
      if (pathname === "/state") {
        try {
          return Response.json(await status(), { headers });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500, headers });
        }
      }
      if (pathname === "/link") {
        try { return Response.json(currentSnapshot(getCtx()), { headers }); }
        catch (e) { return Response.json({ error: (e as Error).message }, { status: 500, headers }); }
      }
      if (pathname === "/events") {
        let timer: ReturnType<typeof setInterval> | undefined;
        let tailTimer: ReturnType<typeof setInterval> | undefined;
        let last = readLatest(getCtx()).seq;
        const clearTimers = () => { clearInterval(timer); clearInterval(tailTimer); };
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = async () => {
              let envelope: unknown;
              try {
                envelope = { v: 1, type: "budget", data: toBudget(await status()) };
              } catch (e) {
                const m = (e as Error).message;
                envelope = { v: 1, type: "alert", data: { key: "status-error", level: "error", title: "pacer status failed", body: m, error: m, at: getCtx().now } };
              }
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(envelope)}\n\n`));
              } catch {
                clearTimers();
              }
            };
            const tail = () => {
              try {
                const ctx = getCtx();
                for (const e of readOutboxSince(ctx, last)) { controller.enqueue(enc.encode(`data: ${JSON.stringify(e.envelope)}\n\n`)); last = e.seq; }
              } catch { clearTimers(); }
            };
            await send();
            timer = setInterval(send, interval);
            tailTimer = setInterval(tail, tailMs);
          },
          cancel() {
            clearTimers();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
      return new Response("not found\n", { status: 404 });
    },
  });
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void Promise.resolve().then(async () => { const ctx = getCtx(); await refreshConsoleTerminals(ctx); return pumpOnce(ctx); }).catch(() => []).finally(() => { busy = false; });
  };
  const pumpTimer = pumpMs > 0 ? setInterval(tick, pumpMs) : undefined;
  return { port: server.port!, token, stop: () => { clearInterval(pumpTimer); server.stop(true); } };
}
