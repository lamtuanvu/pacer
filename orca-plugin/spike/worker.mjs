import { get } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME ?? "";

function httpGet(path) {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(join(home, ".pacer", "token"), "utf8").trim(); }
    catch (e) { resolve(`token unreadable: ${e.message}`); return; }
    const req = get({ host: "127.0.0.1", port: 4317, path, headers: { authorization: `Bearer ${token}` }, timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(`HTTP ${res.statusCode} ${body.slice(0, 200)}`));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve(`error: ${e.message}`));
  });
}

export default async function activate(ctx) {
  ctx.log(`spike activated ${new Date().toISOString()} caps=${ctx.grantedCapabilities.join(",")}`);
  const notify = (title, body) =>
    ctx.host.call("notifications.show", { title: String(title).slice(0, 120), body: String(body).slice(0, 1000) });
  ctx.commands.register("probe-http", async (args) => {
    const r = await httpGet("/state");
    await notify("spike: http", r);
    return { args: args ?? null, r };
  });
  ctx.commands.register("probe-storage", async () => {
    const r = await ctx.host.call("storage.get", { key: "link" });
    await notify("spike: storage", JSON.stringify(r).slice(0, 900));
    return r;
  });
  ctx.commands.register("probe-send", async () => {
    const w = await ctx.host.call("workspace.readContext");
    const id = w?.terminals?.[0]?.id;
    if (!id) { await notify("spike: send", "no terminal in focused worktree"); return w; }
    try {
      const r = await ctx.host.call("terminal.sendText", { terminalId: id, text: ": pacer-spike 'hello'", enter: false });
      await notify("spike: send", `${id} accepted=${r.accepted}`);
      return r;
    } catch (e) { await notify("spike: send failed", `${e.code ?? ""} ${e.message}`); return null; }
  });
  ctx.events.on("agent.status.changed", (p) => ctx.log(`agent.status.changed ${JSON.stringify(p).slice(0, 500)}`));
  ctx.events.on("worktree.created", (p) => ctx.log(`worktree.created ${JSON.stringify(p).slice(0, 500)}`));
  setInterval(() => ctx.log(`alive ${new Date().toISOString()}`), 60_000);
}
