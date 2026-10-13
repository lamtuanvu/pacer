import pkg from "../../package.json";
import { createBootstrap } from "./bootstrap";
import { get, request } from "node:http";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlugin, type Timers } from "./plugin";
import type { HttpPort } from "./transports/http";
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
const PLUGIN_VERSION = pkg.version;
let log = (message: string) => {};
const plugin = createPlugin({
  ownPanel: true,
  bootstrap: createBootstrap({ home: process.env.HOME ?? process.env.USERPROFILE ?? "", env: process.env, version: PLUGIN_VERSION }),
  nowS: () => Date.now() / 1000,
  timers, http,
  home: process.env.HOME ?? process.env.USERPROFILE ?? "",
  pluginRoot,
  fs: {
    readText(path) { try { return readFileSync(path, "utf8"); } catch { return null; } },
    exists: existsSync,
    writeTextAtomic(path, text) {
      // Write only this plugin bundle's panel, including marketplace installs.
      if (resolve(path) !== resolve(pluginRoot, "panel", "live.html")) { log("pacer: refused panel write: unexpected path"); return; }
      const temporary = `${path}.${process.pid}.tmp`;
      try { writeFileSync(temporary, text, "utf8"); renameSync(temporary, path); }
      finally { try { unlinkSync(temporary); } catch { /* renamed, or never written */ } }
    },
  },
});
export default async function activate(ctx: OrcaWorkerContext): Promise<void> { log = message => ctx.log(message); await plugin.activate(ctx); }
export async function deactivate(): Promise<void> { await plugin.deactivate(); }
