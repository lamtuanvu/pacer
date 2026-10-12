import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { readJson } from "../fsutil";
import { DEFAULT_PORT } from "../serve/http";
import { pluginInstalled } from "./bridge";
import { detectChannel } from "./channel";
import { liveConsole, parseSnapshot } from "./envelope";
import { pluginDataDir } from "./paths";
import { publish } from "./publish";
import { currentSnapshot } from "./store";

export async function linkCli(args: string[], ctx: Ctx): Promise<Result> {
  if (args.length !== 1 || !["status", "probe"].includes(args[0])) return { code: 2, out: "", err: "usage: pacer link status|probe\n" };
  if (args[0] === "probe") {
    const report = await publish(ctx, [{ v: 1, type: "alert", data: { key: "probe", level: "info", title: "pacer link probe", body: `sent at ${new Date(ctx.now * 1000).toISOString()}`, at: ctx.now } }]);
    return { code: report.errors.length ? 1 : 0, out: `${JSON.stringify(report, null, 2)}\n`, err: "" };
  }
  const snapshot = currentSnapshot(ctx);
  const file = join(pluginDataDir(ctx), "storage.json");
  const bridge = readJson<{ link?: unknown }>(file);
  const linked = parseSnapshot(bridge?.link);
  const bridgeText = pluginInstalled(ctx) ? `${file} exists=${existsSync(file)}${linked ? ` link.at=${linked.at} age=${Math.max(0, ctx.now - linked.at)}s` : " link unavailable"}` : "plugin not installed";
  const url = `http://127.0.0.1:${DEFAULT_PORT}/link`;
  let serve = "not reachable (token missing)";
  try {
    const token = readFileSync(join(ctx.pacerHome, "token"), "utf8").trim();
    if (token) {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      serve = response.ok ? "reachable" : `not reachable (HTTP ${response.status})`;
      await response.body?.cancel();
    }
  } catch (e) { serve = `not reachable (${e instanceof Error ? e.message : String(e)})`; }
  let channel = "not available";
  try { if (await detectChannel(ctx)) channel = "available"; } catch (e) { channel += ` (${e instanceof Error ? e.message : String(e)})`; }
  const console = liveConsole(snapshot, ctx.now);
  return { code: 0, out: `outbox: seq=${snapshot.seq} at=${snapshot.at}\nbridge: ${bridgeText}\nserve: ${serve} (${url})\nchannel: ${channel}\nconsole: ${console?.handle ?? "not running"}\n`, err: "" };
}
