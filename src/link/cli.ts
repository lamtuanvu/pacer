import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { readJson } from "../fsutil";
import { DEFAULT_PORT } from "../serve/http";
import { pluginDataDir } from "./paths";
import { publish } from "./publish";
import { currentSnapshot } from "./store";

export async function linkCli(args: string[], ctx: Ctx): Promise<Result> {
  if (args.length !== 1 || !["status", "probe"].includes(args[0])) return { code: 2, out: "", err: "usage: pacer link status|probe\n" };
  if (args[0] === "probe") {
    const report = await publish(ctx, [{ type: "alert", data: { key: "probe", level: "info", title: "pacer link probe", body: `sent at ${new Date(ctx.now * 1000).toISOString()}`, at: ctx.now } }]);
    return { code: report.errors.length ? 1 : 0, out: `${JSON.stringify(report, null, 2)}\n`, err: "" };
  }
  const snapshot = currentSnapshot(ctx);
  const settings = readJson<Record<string, unknown>>(join(pluginDataDir(ctx), "settings.json"));
  const port = typeof settings?.port === "number" && Number.isInteger(settings.port) && settings.port > 0 && settings.port <= 65535 ? settings.port : DEFAULT_PORT;
  const pacerHome = typeof settings?.pacerHome === "string" && settings.pacerHome.startsWith("/") ? settings.pacerHome : ctx.pacerHome;
  const url = `http://127.0.0.1:${port}/v2/snapshot`;
  let serve = "not reachable (token missing)";
  try {
    const token = readFileSync(join(pacerHome, "token"), "utf8").trim();
    if (token) {
      const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000), redirect: "error" });
      await health.body?.cancel();
      if (!health.ok || health.headers.get("x-pacer") !== "1") throw new Error("server is not pacer");
      const response = await fetch(url, { redirect: "error", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      serve = response.ok ? "reachable" : `not reachable (HTTP ${response.status})`;
      await response.body?.cancel();
    }
  } catch (e) { serve = `not reachable (${e instanceof Error ? e.message : String(e)})`; }
  return { code: 0, out: `outbox: seq=${snapshot.seq} at=${snapshot.at}\nserve: ${serve} (${url})\n`, err: "" };
}
