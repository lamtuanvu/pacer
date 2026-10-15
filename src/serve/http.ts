import { randomBytes } from "node:crypto";
import { handleV2 } from "../api/http";
import type { OpDeps } from "../api/ops";
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { computeStatus, type Status } from "../engine/status";
import type { Ctx } from "../types";
import { toBudget } from "../link/budget";
import { currentSnapshot, invalidateConsoleCache, refreshConsoleTerminals, readOutboxSince } from "../link/store";
import { defaultPumpDeps, pumpOnce } from "../link/pump";

import { publish } from "../link/publish";
import { consoleOpener, consoleRequestBody } from "./console-open";

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
  getCtx: () => Ctx, opts: { port?: number; sseIntervalMs?: number; tailMs?: number; pumpMs?: number; opDeps?: OpDeps } = {},
): { port: number; token: string; stop: () => void } {
  const initialCtx = getCtx();
  const token = ensureToken(initialCtx);
  const interval = opts.sseIntervalMs ?? 15_000;
  const tailMs = opts.tailMs ?? 1_000;
  const pumpMs = opts.pumpMs ?? 15_000;
  let snapshot = currentSnapshot(initialCtx);
  let cachedStatus: Status | null = null;
  let statusError: string | null = null;
  let statusPending: Promise<void> | null = null;
  let stopped = false;
  const refreshStatus = () => {
    if(statusPending || stopped)return;
    statusPending = Promise.resolve().then(async()=>{
      const ctx=getCtx();
      const next=await computeStatus(ctx,loadStrategy(ctx));
      if(!stopped){cachedStatus=next;statusError=null;}
    }).catch(e=>{if(!stopped)statusError=e instanceof Error?e.message:String(e);}).finally(()=>{statusPending=null;});
  };
  const status = async () => {
    if(statusPending)await statusPending;
    if(statusError)throw Error(statusError);
    if(!cachedStatus)throw Error("status is warming up");
    return cachedStatus;
  };
  let outbox = readOutboxSince(initialCtx,0);
  const refreshSnapshot = () => {
    if(stopped)return;
    try{const ctx=getCtx();snapshot=currentSnapshot(ctx);outbox=readOutboxSince(ctx,0);}catch{ /* Preserve last known data. */ }
  };
  // File notifications update memory outside request handlers; the timer covers missed notifications.
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const scheduleSnapshot=()=>{if(scheduled || stopped)return;scheduled=setTimeout(()=>{scheduled=undefined;refreshSnapshot();},0);};
  const watchers:ReturnType<typeof watch>[]=[];
  for(const dir of [initialCtx.pacerHome,join(initialCtx.pacerHome,"link"),join(initialCtx.pacerHome,"link","consoles")]) {
    mkdirSync(dir,{recursive:true});
    try{watchers.push(watch(dir,()=>{invalidateConsoleCache(initialCtx);scheduleSnapshot();}));}catch{}
  }
  refreshStatus();
  const enc = new TextEncoder();
  const openConsole = consoleOpener(initialCtx.now);

  let pendingJobs=0;
  const jobs=new Set<ReturnType<typeof setTimeout>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? DEFAULT_PORT,
    idleTimeout: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const headers = { "X-Pacer": "1" };
      if (req.method === "GET" && pathname === "/health") return Response.json({ ok: true, pid: process.pid }, { headers });
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized\n", { status: 401 });
      if (pathname.startsWith("/v2/")) return handleV2(req, { getCtx, opDeps: opts.opDeps, tailMs, status });
      if (req.method === "POST" && ["/console/open", "/console/forget"].includes(pathname)) {
        const body=await consoleRequestBody(req);
        if(body instanceof Response)return body;
        if(pendingJobs>=10)return Response.json({ok:false,reason:"busy"},{status:429,headers});
        const url=req.url;
        pendingJobs++;
        const job=setTimeout(()=>{
          jobs.delete(job);
          if(stopped)return;
          void Promise.resolve().then(async()=>{
            const ctx=getCtx();
            const response=await openConsole(new Request(url,{method:"POST",headers:{"content-type":"application/json"},body}),ctx);
            const result=await response.json() as {ok:boolean;reason?:string};
            if(!result.ok)await publish(ctx,[{v:1,type:"alert",data:{key:"console-open",level:"warn",title:"Console request could not finish",body:result.reason??"unknown",at:ctx.now}}],{channel:false});
          }).catch(()=>{}).finally(()=>{pendingJobs--;refreshSnapshot();});
        },0);
        jobs.add(job);
        return Response.json({ok:true,queued:true},{status:202,headers});
      }
      if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
      if (pathname === "/state") {
        return cachedStatus ? Response.json(cachedStatus,{headers}) : Response.json({error:statusError??"status is warming up"},{status:503,headers});
      }
      if (pathname === "/link") return Response.json(snapshot,{headers});
      if (pathname === "/events") {
        let timer: ReturnType<typeof setInterval> | undefined;
        let tailTimer: ReturnType<typeof setInterval> | undefined;
        let last = snapshot.seq;
        const clearTimers = () => { clearInterval(timer); clearInterval(tailTimer); };
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = async () => {
              let envelope: unknown;
              try {
                envelope = { v: 1, type: "budget", data: toBudget(cachedStatus ?? (()=>{throw Error(statusError??"status is warming up");})()) };
              } catch (e) {
                const m = statusError ?? (e as Error).message;
                envelope = { v: 1, type: "alert", data: { key: "status-error", level: "error", title: "pacer status failed", body: m, error: m, at: initialCtx.now } };
              }
              try {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(envelope)}\n\n`));
              } catch {
                clearTimers();
              }
            };
            const tail = () => {
              try {
                for (const e of outbox.filter(e=>e.seq>last)) { controller.enqueue(enc.encode(`data: ${JSON.stringify(e.envelope)}\n\n`)); last = e.seq; }
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
    void Promise.resolve().then(async () => { const ctx = getCtx(); await refreshConsoleTerminals(ctx); if(!cachedStatus){refreshStatus(); await statusPending;} return pumpOnce(ctx,{...defaultPumpDeps,status}); }).catch(() => []).finally(() => { busy = false; refreshSnapshot(); });
  };
  const snapshotTimer=setInterval(refreshSnapshot,2000);
  const statusTimer=setInterval(refreshStatus,60000);
  const terminalTimer=setInterval(()=>{if(!stopped)void Promise.resolve().then(()=>refreshConsoleTerminals(getCtx())).catch(()=>{});},10000);
  const pumpTimer = pumpMs > 0 ? setInterval(tick, pumpMs) : undefined;
  return { port: server.port!, token, stop: () => { stopped=true; clearInterval(pumpTimer); clearInterval(snapshotTimer); clearInterval(statusTimer); clearInterval(terminalTimer); clearTimeout(scheduled); for(const watcher of watchers)watcher.close(); for(const job of jobs)clearTimeout(job); server.stop(true); } };
}
