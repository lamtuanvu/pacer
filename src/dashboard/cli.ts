import { StringDecoder } from "node:string_decoder";
import { attachDirectory, attachSession } from "../session/attach";
import { pacerArgv } from "../install/self";
import { currentVersion } from "../update/version";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { dashboardClient } from "./client";
import { withFallback } from "./data";
import { Dashboard } from "./controller";
import { Keys } from "./input";
import type { ScreenId } from "./state";
import { detectTheme } from "./theme";

export const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
export const LEAVE_SCREEN = "\x1b[0m\x1b[?25h\x1b[?1049l";
export const USAGE = "usage: pacer dashboard [--plain] [--once [--screen home|review|sessions|settings] [--width N]]\n";
const SCREENS: ScreenId[] = ["home", "review", "sessions", "settings", "setup"];

interface Options { plain: boolean; once: boolean; screen: ScreenId; width?: number }
export function parseArgs(args: string[]): Options | string {
  const options: Options = { plain: false, once: false, screen: "home" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--plain") options.plain = true;
    else if (arg === "--once") options.once = true;
    else if (arg === "--screen" && SCREENS.includes(args[i + 1] as ScreenId)) options.screen = args[++i] as ScreenId;
    else if (arg === "--width" && /^\d+$/.test(args[i + 1] ?? "") && Number(args[i + 1]) >= 40) options.width = Number(args[++i]);
    else return USAGE;
  }
  if ((options.screen !== "home" || options.width !== undefined) && !options.once) return USAGE;
  return options;
}

/** Collapse the empty body of a one-shot frame so output is as long as its content. */
export function trimFrame(frame: string): string {
  const lines = frame.split("\n"), footer = lines.length - 3;
  let end = footer;
  while (end > 3 && !lines[end - 1]!.trim()) end--;
  return [...lines.slice(0, end), ...lines.slice(footer)].map(line => line.trimEnd()).join("\n");
}

export async function runDashboard(args: string[], ctx: Ctx): Promise<Result> {
  const options = parseArgs(args);
  if (typeof options === "string") return { code: 2, out: "", err: options };
  if (!options.once && (!process.stdin.isTTY || !process.stdout.isTTY)) return { code: 2, out: "", err: "pacer dashboard needs an interactive terminal; use --once to print one frame\n" };
  const theme = detectTheme(ctx.env, options.once ? false : process.stdout.isTTY === true, { plain: options.plain });
  const primary = await dashboardClient(ctx), localClient = await dashboardClient(ctx, true);
  let dash!: Dashboard;
  const client = withFallback(primary, () => localClient, () => dash.report("pacer serve unavailable; working locally", "warn"));
  let closed = false, suspended = false;
  const write = (frame: string) => {
    if (closed || suspended || options.once) return;
    // Overwrite in place instead of clearing the screen, so frames do not flicker.
    process.stdout.write(`\x1b[H${frame.split("\n").join("\x1b[K\n")}\x1b[K\x1b[J`);
  };
  dash = new Dashboard({
    client, theme, version: currentVersion(), cwd: process.cwd(), write,
    now: () => Date.now() / 1000,
    size: () => ({ width: options.width ?? process.stdout.columns ?? 100, height: options.once ? 200 : process.stdout.rows ?? 24 }),
    update: () => { const u = dash.data.settings.update?.value; return u?.available ? "available" : u ? "current" : undefined; },
  });
  dash.state = { ...dash.state, screen: options.screen };

  if (options.once) {
    try {
      await dash.refresh();
      await dash.settle();
      return { code: 0, out: `${trimFrame(dash.render())}\n`, err: "" };
    } finally { closed = true; client.close(); localClient.close(); }
  }

  let exitError = "";
  let finish!: (code: number) => void;
  const done = new Promise<number>(resolve => { finish = resolve; });
  const quit = (code = 0) => { if (closed) return; closed = true; finish(code); };
  const keys = new Keys(), decoder = new StringDecoder("utf8");
  let escapeTimer: ReturnType<typeof setTimeout> | undefined, queue = Promise.resolve(), busy = false;
  const raw = process.stdin.isRaw;
  const suspend = () => { suspended = true; clearTimeout(escapeTimer); keys.flush(); process.stdin.off("data", input); process.stdin.setRawMode(false); process.stdout.write(LEAVE_SCREEN); };
  const resume = () => { if (closed) return; process.stdin.setRawMode(true); process.stdout.write(ENTER_SCREEN); process.stdin.on("data", input); process.stdin.resume(); suspended = false; dash.draw(); };
  dash.deps.attachHere = async id => { suspend(); try { await attachSession(attachDirectory({ ...ctx, now: Date.now() / 1000 }, id), {}, `pacer ${id}`); } finally { resume(); } };
  dash.deps.handoff = async argv => {
    suspend();
    try { return await Bun.spawn([...pacerArgv(ctx.env), ...argv], { env: ctx.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited; }
    finally { resume(); }
  };
  const run = (key: string) => {
    // Quit stays responsive while a slow action or the first snapshot is pending.
    if (key === "interrupt" || key === "q" && busy && !dash.state.overlay) { quit(key === "interrupt" ? 130 : 0); return; }
    queue = queue.then(async () => {
      if (closed) return;
      busy = true;
      try { if (await dash.key(key) === "quit") quit(0); }
      catch (error) { dash.reportError(error); }
      finally { busy = false; }
    });
  };
  const input = (chunk: Buffer) => {
    clearTimeout(escapeTimer);
    for (const key of keys.feed(decoder.write(chunk))) run(key);
    escapeTimer = setTimeout(() => { for (const key of keys.flush()) run(key); }, 30);
  };
  const interrupt = () => { if (!suspended) quit(130); }, terminate = () => quit(143), hangup = () => quit(129);
  const crash = (error: unknown) => { exitError = `pacer: ${error instanceof Error ? error.message : String(error)}`; quit(1); };
  const restore = () => { process.stdin.setRawMode(raw); process.stdout.write(LEAVE_SCREEN); };
  const redraw = () => dash.draw();
  let timer: ReturnType<typeof setInterval> | undefined, spinner: ReturnType<typeof setInterval> | undefined, unsubscribe: (() => void) | undefined;
  process.on("exit", restore);
  try {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write(ENTER_SCREEN);
    process.stdin.on("data", input); process.stdin.on("end", quit); process.stdout.on("resize", redraw);
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
    process.on("uncaughtException", crash); process.on("unhandledRejection", crash);
    dash.draw();
    void dash.refresh().then(() => {
      if (closed) return;
      unsubscribe = client.subscribe(dash.snapshot.seq, () => { void dash.refresh(); });
      if (dash.supports("update.check")) void client.call("update.check", {}).then(value => { dash.data.settings.update = { value: value as never }; dash.draw(); }).catch(() => {});
    });
    timer = setInterval(() => { void dash.refresh(); }, 2000);
    if (theme.motion) spinner = setInterval(() => dash.tick(), 120);
    return { code: await done, out: "", err: exitError };
  } finally {
    closed = true; unsubscribe?.(); client.close(); localClient.close();
    clearInterval(timer); clearInterval(spinner); clearTimeout(escapeTimer);
    process.stdin.off("data", input); process.stdin.off("end", quit); process.stdin.pause(); process.stdout.off("resize", redraw);
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup);
    process.off("uncaughtException", crash); process.off("unhandledRejection", crash); process.off("exit", restore);
    restore();
  }
}
