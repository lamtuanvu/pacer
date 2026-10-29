import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCtx } from "../../src/ctx";
import { installPlanner } from "../../src/install";
import { shellCommand } from "../../src/install/fsx";
import { pacerArgv } from "../../src/install/self";
import { binaryInFile, serviceBackend, servicePath } from "../../src/service";
import { record, type Session } from "./core";

/** Fixed fixture only. Manager capture is not evidence of a real installation. */
export async function exerciseIntegrationSelection(
  session: Session, root: string, front: string, core: string,
): Promise<void> {
  if (!Number.isInteger(session.port) || session.port < 1 || session.port > 65535 || session.port === 4317) {
    throw Error("Integration fixture requires the recorded nondefault sandbox port");
  }
  const home = join(root, "integration-home");
  mkdirSync(home, { mode: 0o700 }); // Exclusive: refuse partial/reused state.
  const codex = join(home, ".codex"), claude = join(home, ".claude");
  const env = {
    HOME: home, PACER_HOME: join(home, ".pacer"), PACER_BIN: front,
    CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(home, "tmp"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1",
    PACER_PORT: String(session.port), LANG: "C",
  };
  mkdirSync(env.TMPDIR, { mode: 0o700 });
  const must = (ok: boolean, message: string) => { if (!ok) throw Error(message); };
  const run = async (argv: string[], extra: Record<string, string> = {}, stdin?: string) => {
    const child = Bun.spawn(argv, {
      cwd: home, env: { ...env, ...extra }, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    record(session, { kind: "command", argv, code, stdout, stderr });
    return { code, stdout, stderr };
  };
  // setup has no read-only success mode. Its invalid/help argument exits in the
  // initial parser, before detection, config writes or manager operations.
  const forwarded = await run([front, "setup", "--help"]);
  const direct = await run([core, "setup", "--help"]);
  must(forwarded.code === 2 && JSON.stringify(forwarded) === JSON.stringify(direct), "Setup parser forwarding differs from sibling core");
  must(!existsSync(codex) && !existsSync(claude), "Setup parser probe wrote planner configuration");
  must(!existsSync(env.PACER_HOME) || (readdirSync(env.PACER_HOME).join(",") === "run" && readdirSync(join(env.PACER_HOME, "run")).join(",") === "core-version.json"), "Setup parser probe wrote more than the Core startup version marker");
  record(session, { kind: "note", behavior: "Rust forwarded setup parser", surface: "compiled CLI", verdict: "PASS", text: "Installed Rust front and sibling core returned identical setup usage refusal with no configuration beyond the optional Core startup version marker. This covers parser forwarding only, not successful onboarding." });

  const ctx = makeCtx({ home, pacerHome: env.PACER_HOME, env, which: () => null,
    run: async () => { throw Error("Unexpected installer subprocess"); } });
  await installPlanner({ ctx, pacerArgv: pacerArgv(env), mcp: false, folder: codex }, "codex");
  const hooks = JSON.parse(readFileSync(join(codex, "hooks.json"), "utf8"));
  const actual = hooks.hooks.SessionStart[0].hooks[0].command;
  must(actual === shellCommand([front, "status", "--hook", "codex"]), "Generated planner hook did not select installed Rust front");
  must(!readFileSync(join(codex, "AGENTS.md"), "utf8").includes(core), "Planner policy selected companion directly");
  record(session, { kind: "note", behavior: "Planner PACER_BIN selection", surface: "actual Codex installer", verdict: "PASS", text: "Actual installer generated the exact installed Rust executable status hook in disposable CODEX_HOME; no MCP registration, tool credentials or agent subprocess. Hook execution against a running service is separate evidence." });

  // No executors/providers or native login indicators are installed. The fixed
  // disabled policy exercises rendering without authorizing delegated work.
  writeFileSync(join(env.PACER_HOME, "strategy.yaml"),
    "accounts: {personal: {kind: codex}}\nplanner: codex#personal\nrunners: {}\n", { mode: 0o600, flag: "wx" });
  const input = JSON.stringify({ cwd: home, hook_event_name: "SessionStart" });
  const policy = { PACER: "off" };
  const hook = await run([front, "status", "--hook", "codex"], policy, input);
  const coreHook = await run([core, "status", "--hook", "codex"], policy, input);
  must(hook.code === 0 && hook.stderr === "" && hook.stdout.trim() ===
    "pacer delegation policy is OFF for this session (PACER=off). Do the work directly.",
    "Generated hook did not render the fixed disabled policy");
  must(JSON.stringify(hook) === JSON.stringify(coreHook), "Generated Rust hook differs from direct Core");
  const executorHook = await run([front, "status", "--hook", "codex"],
    { ...policy, PACER_ROLE: "executor" }, input);
  must(executorHook.code === 0 && executorHook.stdout === "" && executorHook.stderr === "",
    "Executor session received planner hook policy");
  record(session, { kind: "note", behavior: "Generated Rust planner hook execution", surface: "compiled CLI", verdict: "PASS", text: "Exact generated hook argv executed without a shell with fixed JSON stdin and disabled private strategy; rendered nontrivial policy matched direct Core. Executor-role control returned no planner output. No agent trust acceptance or delegated execution claimed." });

  for (const platform of ["darwin", "linux"]) {
    let captured = "", observed = false;
    const calls: string[][] = [];
    const serviceCtx = makeCtx({ ...ctx, run: async argv => {
      calls.push([...argv]);
      const expected = platform === "darwin" ? "launchctl" : "systemctl";
      const path = servicePath(ctx, platform), target = "gui/501/com.pacer.serve";
      const allowed = platform === "darwin" ? [
        [expected, "print", target], [expected, "bootout", target],
        [expected, "bootstrap", "gui/501", path],
      ] : [
        [expected, "--user", "show", "pacer-serve.service", "--property=Environment"],
        [expected, "--user", "daemon-reload"],
        [expected, "--user", "enable", "--now", "pacer-serve.service"],
        [expected, "--user", "disable", "--now", "pacer-serve.service"],
      ];
      must(allowed.some(recipe => JSON.stringify(recipe) === JSON.stringify(argv)), "Unexpected manager recipe");
      if (argv.includes("print") || argv.includes("show")) return { code: 1, stdout: "", stderr: "not found" };
      if (argv.includes("bootstrap") || argv.includes("enable")) {
        captured = readFileSync(servicePath(ctx, platform), "utf8");
        observed = true;
        return { code: 1, stdout: "", stderr: "fixed fixture activation refusal" };
      }
      return { code: 0, stdout: "", stderr: "" };
    } });
    let failure = "";
    try { await serviceBackend(serviceCtx, { platform, uid: 501 }).install(); }
    catch (error) { failure = (error as Error).message; }
    must(observed && failure.includes("fixed fixture activation refusal"), "Service installer did not reach controlled activation refusal");
    must(binaryInFile(captured, platform) === front, "Service installer did not select Rust PACER_BIN");
    must(!existsSync(servicePath(ctx, platform)), "Failed fixture activation left registration behind");
    record(session, { kind: "note", behavior: `Service PACER_BIN selection (${platform})`, surface: "actual installer/fixed manager capture", verdict: "PASS", text: `Actual installer generated Rust-front serve registration, reached captured activation, and rolled back on fixed refusal (${calls.length} captured manager calls). No manager process ran; loaded/healthy service is UNVERIFIED by this capture.` });
  }
}
