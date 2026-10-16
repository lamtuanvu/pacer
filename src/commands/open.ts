import type { Ctx } from "../types";
import type { Command, Result } from "./types";
import { clearSessions, createCode } from "../serve/app-auth";
import { DEFAULT_PORT } from "../serve/http";

export const OPEN_USAGE = "open [--print] [--logout] [<screen>]             open the pacer app (requires pacer serve)";
export type OpenDeps = { opener: (url: string) => Promise<void> };
const defaultOpener: OpenDeps["opener"] = async url => {
  const result = await Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" }).exited;
  if (result !== 0) throw Error("could not open the browser; run pacer open --print");
};

export async function openCmd(args: string[], ctx: Ctx, deps: OpenDeps = { opener: defaultOpener }): Promise<Result> {
  const screens = args.filter(a => !a.startsWith("--"));
  if (args.some(a => a.startsWith("--") && !["--print", "--logout"].includes(a)) || screens.length > 1) {
    return { code: 2, out: "", err: `usage: pacer ${OPEN_USAGE}` };
  }
  try {
    if (args.includes("--logout")) {
      clearSessions(ctx);
      return { code: 0, out: "Signed out of the pacer app.", err: "" };
    }
    const port = Number(ctx.env.PACER_PORT ?? DEFAULT_PORT);
    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
      if (!health.ok || health.headers.get("x-pacer") !== "1" || (await health.json()).ok !== true) throw Error("not pacer");
    } catch {
      return { code: 1, out: "", err: "pacer isn't running. Start it with: pacer service install" };
    }
    const url = new URL(`${base}/app/auth`);
    url.searchParams.set("code", createCode(ctx));
    if (screens[0]) url.hash = `/${screens[0].replace(/^\/+/, "")}`;
    if (args.includes("--print")) return { code: 0, out: url.href, err: "" };
    await deps.opener(url.href);
    return { code: 0, out: "", err: "" };
  } catch (e) {
    return { code: 1, out: "", err: `pacer: ${(e as Error).message}` };
  }
}

export const COMMANDS: Command[] = [{ name: "open", usage: OPEN_USAGE, run: openCmd }];
