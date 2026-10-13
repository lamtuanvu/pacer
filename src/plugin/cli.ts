import { renderUninstall } from "../install/index";
import { pacerArgv } from "../install/self";
import { pluginInstalled, writePluginSetting } from "../link/bridge";
import { linkCli } from "../link/cli";
import type { Result } from "../commands/types";
import type { Ctx } from "../types";
import { installPlugin, uninstallPlugin } from "./install";
import { legacyPluginInstalled } from "./migration";

const USAGE = "usage: pacer plugin install|uninstall|status|set <transport|port|pacerHome|pollSeconds|autoConsole|notifications> <value>";
const err = (code: number, e: unknown): Result => ({ code, out: "", err: `pacer: ${e instanceof Error ? e.message : String(e)}` });

export function parseSetting(key: string, value: string): unknown {
  switch (key) {
    case "notifications":
      if(!["off","important","all"].includes(value))throw new Error("notifications must be off, important or all");
      return value;
    case "autoConsole":
      if (!["on", "off"].includes(value)) throw new Error("autoConsole must be on or off");
      return value === "on";
    case "transport":
      if (!["auto", "http", "channel", "bridge"].includes(value)) throw new Error("transport must be auto, http, channel or bridge");
      return value;
    case "port": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("port must be 1..65535");
      return n;
    }
    case "pollSeconds": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 5 || n > 300) throw new Error("pollSeconds must be 5..300");
      return n;
    }
    case "pacerHome":
      if (!value.startsWith("/")) throw new Error("pacerHome must be an absolute path");
      return value;
    default: throw new Error(`unknown setting ${key}`);
  }
}

export async function pluginCli(args: string[], ctx: Ctx): Promise<Result> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "install":
        return { code: 0, out: (await installPlugin({ ctx, pacerArgv: pacerArgv(ctx.env) })).text, err: "" };
      case "uninstall": {
        const r = await uninstallPlugin(ctx);
        return r ? { code: 0, out: renderUninstall(r), err: "" } : { code: 1, out: "", err: "pacer: the Orca plugin is not installed" };
      }
      case "status": {
        const result = await linkCli(["status"], ctx);
        if (legacyPluginInstalled(ctx)) result.out += "\nlegacy plugin installed; run pacer plugin install to migrate to lamtuanvu.pacer";
        return result;
      }
      case "set": {
        if (rest.length !== 2) return { code: 2, out: "", err: USAGE };
        let v: unknown;
        try { v = parseSetting(rest[0], rest[1]); } catch (e) { return err(2, e); }
        if (!pluginInstalled(ctx)) return err(1, "the Orca plugin is not installed; run pacer plugin install first");
        writePluginSetting(ctx, rest[0], v);
        return { code: 0, out: `plugin setting ${rest[0]} = ${JSON.stringify(v)} (${rest[0]==="notifications"?"takes effect within 30 seconds":"takes effect after reloading the plugin in Orca"})`, err: "" };
      }
      default:
        return { code: 2, out: "", err: USAGE };
    }
  } catch (e) { return err(1, e); }
}
