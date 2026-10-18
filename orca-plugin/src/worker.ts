import { HttpClient } from "../../src/api/http-client";
import { StdioClient } from "../../src/api/stdio-client";
import { writeLiveHeartbeat, removeLiveHeartbeat } from "../../src/plugin/live";
import { checkForUpdate, readUpdateCheck } from "../../src/update/check";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isVersion } from "../../src/update/version";
import pkg from "../../package.json";
import { pluginMode } from "./mode";
import { createBootstrap } from "./bootstrap";
import { get, request } from "node:http";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlugin, type Timers } from "./plugin";
import type { HttpPort } from "./http-port";
import type { OrcaWorkerContext } from "./orca-api";
const timers: Timers = {
  every(ms, fn) { const timer = setInterval(fn, ms); return () => clearInterval(timer); },
  after(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
};
function checkLoopback(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.username || u.password) throw new Error("pacer worker only supports loopback HTTP");
}
const http: HttpPort = {
  post(url, token, data, timeoutMs) {
    return new Promise((resolve, reject) => {
      checkLoopback(url);
      const body = JSON.stringify(data);
      const req = request(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
        let response = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { response += chunk; if (Buffer.byteLength(response) > 256 * 1024) req.destroy(new Error("pacer response exceeds 256 KiB")); });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: response, headers: res.headers }));
      });
      const timeout = setTimeout(() => req.destroy(new Error("pacer HTTP timeout")), timeoutMs);
      req.on("close", () => clearTimeout(timeout)); req.on("error", reject); req.end(body);
    });
  },
  get(url, token, timeoutMs) {
    return new Promise((resolve, reject) => {
      checkLoopback(url);
      const req = get(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 256 * 1024) req.destroy(new Error("pacer snapshot exceeds 256 KiB")); });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      const timeout = setTimeout(() => req.destroy(new Error("pacer HTTP timeout")), timeoutMs);
      req.on("close", () => clearTimeout(timeout));
      req.on("error", reject);
    });
  },
  stream(url, token, onLine, onClose) {
    checkLoopback(url);
    let stopped = false, closed = false;
    const close = (err?: Error) => { if (!stopped && !closed) { closed = true; onClose(err); } };
    const req = get(url, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } }, res => {
      if (res.statusCode !== 200) { res.resume(); close(new Error(`pacer events HTTP ${res.statusCode}`)); req.destroy(); return; }
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        if (stopped) return;
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) { onLine(buffer.slice(0, newline).replace(/\r$/, "")); buffer = buffer.slice(newline + 1); }
        if (Buffer.byteLength(buffer) > 256 * 1024) req.destroy(new Error("pacer SSE line exceeds 256 KiB"));
      });
      res.on("end", () => close()); res.on("close", () => close()); res.on("error", close);
    });
    req.on("error", close);
    return () => { stopped = true; req.destroy(); };
  },
};
const pluginRoot = dirname(fileURLToPath(import.meta.url));
const PLUGIN_VERSION = (() => {
  try { const version = JSON.parse(readFileSync(join(pluginRoot,"orca-plugin.json"),"utf8")).version; if(isVersion(version)) return version as string; } catch {}
  return pkg.version;
})();
let log = (message: string) => {};
const workerEnv = {...process.env};
const pacerHome = workerEnv.PACER_HOME || join(workerEnv.HOME ?? workerEnv.USERPROFILE ?? "", ".pacer");
const plugin = createPlugin({
  async connect(settings) {
    const base = `http://127.0.0.1:${settings.port}`;
    try {
      const health = await http.get(`${base}/health`, "", 500);
      if (health.status === 200 && health.headers?.["x-pacer"] === "1") {
        const token = readFileSync(join(settings.pacerHome, "token"), "utf8").trim();
        if (token) return new HttpClient(base, token);
      }
    } catch { /* No identified daemon with a token; use a headless client. */ }
    try {
      const binary = workerEnv.PACER_BIN || (existsSync(join(workerEnv.HOME ?? "", ".local/bin/pacer")) ? join(workerEnv.HOME ?? "", ".local/bin/pacer") : "pacer");
      // The binary is resolved here, so the worker never imports pacer's task code to find itself.
      const env = { ...workerEnv, PACER_BIN: binary, PACER_HOME: settings.pacerHome };
      return new StdioClient([binary], env, { log: m => log(m) });
    } catch { return null; }
  },
  version: PLUGIN_VERSION,
  cachedUpdate: () => readUpdateCheck({pacerHome,env:workerEnv}, PLUGIN_VERSION),
  reportVersion(mode, version) { mkdirSync(pacerHome, {recursive:true}); const path=join(pacerHome,"plugin-version.json"), temp=`${path}.${process.pid}.tmp`; writeFileSync(temp,JSON.stringify({mode,version})); renameSync(temp,path); },
  async checkUpdates() {
    const check = await checkForUpdate({pacerHome, env:workerEnv, now:Date.now()/1000}, {force:true,current:PLUGIN_VERSION});
    const binary = workerEnv.PACER_BIN || (existsSync(join(workerEnv.HOME ?? "", ".local/bin/pacer")) ? join(workerEnv.HOME ?? "", ".local/bin/pacer") : "pacer");
    const cli = await new Promise<string|null>(resolve => execFile(binary,["--version"],{timeout:3000,env:workerEnv},(error,stdout)=>resolve(error?null:stdout.trim().replace(/^pacer\s+/,""))));
    return {check,cli};
  },
  bootstrap: createBootstrap({ home: process.env.HOME ?? process.env.USERPROFILE ?? "", env: process.env, version: PLUGIN_VERSION, mode: pluginMode(pluginRoot, { exists: existsSync }) }),
  nowS: () => Date.now() / 1000,
  timers, http,
  home: process.env.HOME ?? process.env.USERPROFILE ?? "",
  pluginRoot,
  fs: {
    readText(path) { try { return readFileSync(path, "utf8"); } catch { return null; } },
    exists: existsSync,
    writeTextAtomic(path, text) {
      // Never mutate an integrity-checked marketplace folder.
      if (pluginMode(pluginRoot, { exists: existsSync }) !== "live" || resolve(path) !== resolve(pluginRoot, "panel", "live.html")) { log("pacer: refused panel write: unexpected path"); return; }
      const temporary = `${path}.${process.pid}.tmp`;
      try { writeFileSync(temporary, text, "utf8"); renameSync(temporary, path); }
      finally { try { unlinkSync(temporary); } catch { /* renamed, or never written */ } }
    },
  },
});
let liveTimer: ReturnType<typeof setInterval> | undefined;
export default async function activate(ctx: OrcaWorkerContext): Promise<void> {
  log = message => ctx.log(message);
  if (pluginMode(pluginRoot, { exists: existsSync }) === "live") {
    const heartbeat = () => { try { writeLiveHeartbeat(pacerHome, { version: PLUGIN_VERSION, pid: process.pid, at: Date.now() / 1000 }); } catch (e) { log(`pacer heartbeat: ${e}`); } };
    heartbeat(); liveTimer = setInterval(heartbeat, 30_000);
  }
  await plugin.activate(ctx);
}
export async function deactivate(): Promise<void> { clearInterval(liveTimer); removeLiveHeartbeat(pacerHome, process.pid); await plugin.deactivate(); }
