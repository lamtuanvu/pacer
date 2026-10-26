import type { Ctx } from "../types";
import type { Command, Result } from "./types";
import { clearSessions, createCode } from "../serve/app-auth";
import { DEFAULT_PORT } from "../serve/constants";

export const OPEN_USAGE = "open [--print] [--logout] [--browser] [<screen>]  open the pacer app (requires pacer serve)";
export type OpenDeps = { opener: (url: string) => Promise<void> };
const defaultOpener: OpenDeps["opener"] = async url => {
  const result = await Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" }).exited;
  if (result !== 0) throw Error("could not open the browser; run pacer open --print");
};

/** CLI screen names resolve before opening either desktop or browser. */
export function screenRoute(screen = "overview"): string {
  const [name = "", ...rest] = screen.replace(/^\/+/, "").split("/");
  if (name === "executors" && rest.join("/") === "add") return "/settings/add-executor";
  const root = ({ overview: "", home: "", setup: "", delegate: "", tasks: "sessions", session: "sessions", executors: "settings/executors", accounts: "settings/accounts", hosts: "settings/hosts", strategy: "settings/dispatcher" } as Record<string, string>)[name] ?? name;
  return `/${[root, ...rest].filter(Boolean).join("/")}`;
}

/** Let the registered desktop handler open its own authenticated session. */
export async function openDesktop(ctx: Ctx, screen = "overview", platform = process.platform): Promise<boolean> {
  const route = screenRoute(screen);
  const url = `pacer://${route === "/" ? "overview" : route.slice(1)}`;
  const argv = platform === "darwin" ? ["open", "-b", "dev.pacer.desktop", url]
    : platform === "linux" ? ["xdg-open", url] : null;
  if (!argv) return false;
  const result = await ctx.run(argv, 5000).catch(() => null);
  return result?.code === 0;
}

/** Open the app in an Orca browser tab when Orca is running, so it lives next to the work. */
export async function openInOrca(ctx: Ctx, url: string): Promise<boolean> {
  if (!ctx.which("orca")) return false;
  const status = await ctx.run(["orca", "status"], 5000).catch(() => null);
  if (!status || status.code !== 0 || !/runtimeReachable:\s*true/.test(status.stdout)) return false;
  const tab = await ctx.run(["orca", "tab", "create", "--url", url, "--worktree", "active"], 10000).catch(() => null);
  return !!tab && tab.code === 0;
}

export async function openCmd(args: string[], ctx: Ctx, deps: OpenDeps = { opener: defaultOpener }): Promise<Result> {
  const screens = args.filter(a => !a.startsWith("--"));
  if (args.some(a => a.startsWith("--") && !["--print", "--logout", "--browser"].includes(a)) || screens.length > 1) {
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
    if (!args.includes("--browser") && !args.includes("--print") && await openDesktop(ctx, screens[0])) return { code: 0, out: "Opened the pacer desktop app.", err: "" };
    const url = new URL(`${base}/app/auth`);
    url.searchParams.set("code", createCode(ctx));
    url.hash = screenRoute(screens[0]);
    if (args.includes("--print")) return { code: 0, out: url.href, err: "" };
    if (!args.includes("--browser") && await openInOrca(ctx, url.href)) return { code: 0, out: "Opened the pacer app in an Orca browser tab.", err: "" };
    await deps.opener(url.href);
    return { code: 0, out: "", err: "" };
  } catch (e) {
    return { code: 1, out: "", err: `pacer: ${(e as Error).message}` };
  }
}

export const COMMANDS: Command[] = [{ name: "open", usage: OPEN_USAGE, run: openCmd }];
