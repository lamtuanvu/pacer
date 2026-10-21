import { chromium } from "playwright-core";
import { chmodSync, mkdirSync, readFileSync, rmSync, openSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { atomicWrite, loadSession, run, sandboxEnv, type Session } from "../core";
import { createBrowserAdapter } from "./browser";
import { dispatch } from "./dispatch";
import { createCaptureWriter, recordStep } from "./evidence";
import { ControlError, parseResult, type ControlRequest, type ControlResult } from "./contract";
import { acquireLease, processIdentity, sameProcess, type ProcessIdentity } from "./lease";
import { spawn } from "node:child_process";

interface WorkerState { identity: ProcessIdentity; socket: string; token: string; run_id: string; source_hash: string }
function controlSourceHash(): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(import.meta.dir).filter(name => name.endsWith(".ts")).sort()) hash.update(readFileSync(join(import.meta.dir, name)));
  return hash.digest("hex");
}
const statePath = (session: Session) => join(session.root, "browser-worker.json");
async function workerFetch(state: WorkerState, path: string, body?: unknown) {
  return fetch(`http://localhost${path}`, { unix: state.socket, method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path === "/health" ? 1000 : path === "/close" ? 2000 : 60000) });
}
async function readWorker(session: Session): Promise<WorkerState | null> {
  try {
    const state: WorkerState = JSON.parse(readFileSync(statePath(session), "utf8"));
    if (state.run_id !== session.id || !await sameProcess(state.identity)) return null;
    const response = await workerFetch(state, "/health");
    return response.ok && (await response.json() as {run_id: string}).run_id === session.id ? state : null;
  } catch { return null; }
}
export async function browserCommand(session: Session, request: ControlRequest): Promise<ControlResult> {
  const lease = await acquireLease(`browser-${createHash("sha256").update(session.root).digest("hex").slice(0, 20)}`, { run_id: session.id });
  try {
    let state = await readWorker(session);
    if (!state) {
      const logFd = openSync(join(session.root, "logs/browser-worker.log"), "a", 0o600);
      try {
        const child = spawn(process.execPath, [import.meta.path, "serve", session.id], { cwd: join(import.meta.dir, "../../.."), detached: true, stdio: ["ignore", logFd, logFd], env: process.env }); child.unref();
      } finally { closeSync(logFd); }
      const deadline = Date.now() + 60000;
      while (!state && Date.now() < deadline) { await Bun.sleep(100); state = await readWorker(session); }
      if (!state) throw new ControlError("observer_unavailable", "browser worker did not become ready; inspect logs/browser-worker.log");
    }
    if (state.source_hash !== controlSourceHash()) throw new ControlError("worker_stale", "control sources changed; run live browser stop then retry");
    try {
      const response = await workerFetch(state, "/command", request);
      if (!response.ok) throw new ControlError("observer_unavailable", `worker returned HTTP ${response.status}`);
      return parseResult(await response.json());
    } catch (error) {
      // Never retry after handing an action to the worker: it may have executed.
      throw new ControlError("observer_unavailable", String(error), request.command === "act" ? "unknown" : undefined);
    }
  } finally { await lease.release(); }
}
export async function stopBrowserWorker(session: Session): Promise<void> {
  const state = await readWorker(session);
  if (state) {
    await workerFetch(state, "/close");
    const deadline = Date.now() + 5000;
    while (await sameProcess(state.identity) && Date.now() < deadline) await Bun.sleep(50);
    if (await sameProcess(state.identity)) throw new ControlError("busy", "owned browser worker has not exited; inspect before retrying");
  }
}
async function serve(session: Session): Promise<void> {
  const sourceHash = controlSourceHash();
  const { appendFileSync } = await import("node:fs");
  const log = (message: string) => appendFileSync(join(session.root, "logs/browser-worker.log"), message + "\n", { mode: 0o600 });
  const executablePath = process.env.PACER_LIVE_BROWSER ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : Bun.which("chromium") ?? Bun.which("google-chrome"));
  if (!executablePath) throw new ControlError("observer_unavailable", "set PACER_LIVE_BROWSER to an installed Chromium executable");
  const browser = await chromium.launch({ executablePath, headless: process.env.PACER_LIVE_HEADLESS === "1", timeout: 15000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const origin = `http://127.0.0.1:${session.port}`;
  try {
    const login = await run([sandboxEnv(session).PACER_BIN!, "open", "--print"], session, false);
    const url = login.stdout.match(/http:\/\/127\.0\.0\.1:[0-9]+\/app\/auth\?[^\s]+/)?.[0];
    if (login.code || !url || new URL(url).origin !== origin) throw new ControlError("observer_unavailable", "sandbox login URL unavailable");
    const page = await context.newPage(); await page.goto(url, { timeout: 15000 });
    const tray = await context.newPage(); await tray.goto(`${origin}/app/tray.html`, { timeout: 15000 });
    const adapter = createBrowserAdapter(context, origin);
    const socketRoot = join(tmpdir(), `pacer-live-${process.getuid?.() ?? "user"}`); mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
    const socket = join(socketRoot, createHash("sha256").update(session.root).digest("hex").slice(0, 24) + ".sock"); rmSync(socket, { force: true });
    const token = randomBytes(32).toString("hex"); let busy = false;
    const server = Bun.serve({ unix: socket, maxRequestBodySize: 256 * 1024, async fetch(req) {
      if (req.headers.get("Authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ run_id: session.id });
      if (path === "/close") { setTimeout(() => { void browser.close().finally(() => { server.stop(true); rmSync(socket, { force: true }); process.exit(0); }); }, 10); return Response.json({ ok: true }); }
      if (path !== "/command" || req.method !== "POST") return new Response("Not found", { status: 404 });
      if (busy) return new Response("Busy", { status: 409 });
      if (Number(req.headers.get("Content-Length") ?? 0) > 256 * 1024) return new Response("Too large", { status: 413 });
      busy = true;
      try {
        const body = await req.text(); if (body.length > 256 * 1024) return new Response("Too large", { status: 413 });
        const result = await dispatch(JSON.parse(body), adapter, createCaptureWriter(session)); result.run_id = session.id; recordStep(session, result); return Response.json(result);
      } catch (error) { log(String(error)); return Response.json({ error: "invalid command" }, { status: 400 }); }
      finally { busy = false; }
    } });
    chmodSync(socket, 0o600);
    const identity = await processIdentity(process.pid);
    if (!identity) throw new ControlError("observer_unavailable", "worker identity unavailable");
    atomicWrite(statePath(session), JSON.stringify({ identity, socket, token, run_id: session.id, source_hash: sourceHash } satisfies WorkerState));
    browser.on("disconnected", () => { server.stop(true); rmSync(socket, { force: true }); process.exit(0); });
  } catch (error) { log(String(error)); await browser.close(); throw error; }
}
if (import.meta.main && process.argv[2] === "serve") {
  await serve(loadSession(process.argv[3]));
}
