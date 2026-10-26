import { exerciseIntegrations } from "./integrations";
import { copyFileSync, chmodSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { atomicWrite, down, environmentScript, healthy, loadSession, readEvidence, record, renderReport, run, sandboxEnv, sessions, up } from "./core";
import { cleanupOta, exerciseOta, prepareOta } from "./ota";
import { buildOtaFixtures } from "./ota-build";
import { desktop, tui } from "./surfaces";
import { exerciseUpdater } from "./updater";
import { exerciseRepair } from "./core-repair";
import { CONTROL_COMMANDS, controlMain } from "./control/cli";

const usage = `usage: bun run live <command> [--id <id>]
  up [--repo-template <dir>] [--seed ui] [--front-door rust]
                                  start isolated service and disposable repo; ui seeds sample data
  ota prepare --from-app <path> --to-app <path>
                                  copy disposable OTA bundles (requires --id)
  ota build [--signer cert] [--initial-layout bridge|paired] [--fixture-continue-old-service] [--baseline-process-type Background|Standard]
                                  compile isolated signed native fixtures (requires --id);
                                  cert signs with a disposable pinned certificate
  ota exercise --scenario <name>  run a fixed native fixture scenario (requires --id)
  ota cleanup                    remove recorded OTA copies (requires --id)
  targets|inspect|act|wait|assert|capture|doctor --surface web|tray|tui|desktop --json
                                  inspect and control sandbox UI
  doctor --surface desktop --request-accessibility
                                  ask macOS to show Accessibility approval
  integrations --id <id>          exercise fixed private integration refresh fixtures
  updater --id <id>               exercise fixed disposable CLI updater fixtures (seeded sandbox)
  repair --id <id>                exercise fixed disposable core self-repair fixtures (seeded sandbox)
  env                             print sandbox export lines
  pacer -- <args...>               run guarded checkout CLI in sandbox repo
  login [--screen <screen>]        print fresh single-use app login URL
  tui start|keys <keys...>|capture [--out <name>]|stop
  desktop [--app <path>]           launch built macOS app
  note [--behavior <b> --surface <s> --verdict PASS|FAIL|UNVERIFIED]
       [--steps <text>] <text>     record observed behavior
  attach <file>                   copy evidence into sandbox
  report                          render evidence/report.md
  status                          list sandboxes (or select --id)
  down [--keep]                   stop processes; --keep preserves evidence`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") { console.log(usage); return 0; }
  if (CONTROL_COMMANDS.has(command) || command === "scenario") return controlMain(argv);
  // Only parse harness options before --, so guarded CLI options pass through untouched.
  const separator = rest.indexOf("--");
  const before = separator < 0 ? rest : rest.slice(0, separator);
  const forwarded = separator < 0 ? [] : rest.slice(separator + 1);
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const valueOptions = new Set(["--id", "--front-door", "--from-app", "--to-app", "--scenario", "--seed", "--repo-template", "--screen", "--out", "--app", "--behavior", "--surface", "--verdict", "--steps", "--signer", "--initial-layout", "--baseline-process-type"]);
  for (let i = 0; i < before.length; i++) {
    const arg = before[i];
    if (valueOptions.has(arg)) {
      if (!before[i + 1] || before[i + 1].startsWith("--")) throw Error(`${arg} requires a value`);
      options.set(arg, before[++i]);
    } else if (["--keep", "--print", "--fixture-continue-old-service"].includes(arg)) flags.add(arg);
    else if (arg.startsWith("--")) throw Error(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  const id = options.get("--id");
  if (command !== "ota" && ["--from-app", "--to-app", "--scenario", "--signer", "--initial-layout", "--baseline-process-type"].some(key => options.has(key))) throw Error("OTA options require the ota command");
  if (flags.has("--fixture-continue-old-service") && command !== "ota") throw Error("Fixture old-service choice requires OTA build");
  if (options.has("--seed") && command !== "up") throw Error("--seed is only valid for up");
  if (options.has("--front-door") && command !== "up") throw Error("--front-door is only valid for up");
  if (command === "up") {
    console.log(JSON.stringify(await up(id, options.get("--repo-template"), undefined, options.get("--seed"), options.get("--front-door")), null, 2));
    return 0;
  }
  if (command === "status") {
    const rows = id ? [loadSession(id)] : sessions();
    console.log(JSON.stringify(await Promise.all(rows.map(async session => ({ ...session, running: await healthy(session) }))), null, 2));
    return 0;
  }
  if (command === "ota") {
    if (!id || positionals.length !== 1 || forwarded.length || [...flags].some(flag => flag !== "--fixture-continue-old-service")) throw Error("usage: live ota build|prepare|exercise|cleanup --id <id>");
    const action = positionals[0];
    if (flags.has("--fixture-continue-old-service") && action !== "build") throw Error("Fixture old-service choice requires OTA build");
    const allowed = action === "prepare" ? ["--id", "--from-app", "--to-app"] : action === "exercise" ? ["--id", "--scenario"] : action === "build" ? ["--id", "--signer", "--initial-layout", "--baseline-process-type"] : ["--id"];
    if ([...options.keys()].some(key => !allowed.includes(key))) throw Error("Unsupported OTA option");
    if (action === "prepare") {
      if (!options.has("--from-app") || !options.has("--to-app")) throw Error("OTA prepare requires --from-app and --to-app");
      await prepareOta(id, options.get("--from-app")!, options.get("--to-app")!);
    } else if (action === "exercise") {
      if (!options.has("--scenario")) throw Error("OTA exercise requires --scenario");
      await exerciseOta(id, options.get("--scenario")!);
    } else if (action === "build") {
      const signer = options.get("--signer") ?? "adhoc";
      if (signer !== "adhoc" && signer !== "cert") throw Error("OTA build --signer must be adhoc or cert");
      const layout = options.get("--initial-layout") ?? "bridge";
      if (layout !== "bridge" && layout !== "paired") throw Error("OTA build --initial-layout must be bridge or paired");
      if (flags.has("--fixture-continue-old-service") && layout !== "paired") throw Error("Fixture old-service choice requires paired layout");
      const priority = options.get("--baseline-process-type") ?? "Background";
      if (priority !== "Background" && priority !== "Standard") throw Error("--baseline-process-type must be Background or Standard");
      if (priority === "Standard" && layout !== "paired") throw Error("Standard baseline requires paired layout");
      if (flags.has("--fixture-continue-old-service") && priority === "Standard") throw Error("Fixture old-service choice and Standard baseline require a distinct compiled lease");
      await buildOtaFixtures(id, signer, layout, flags.has("--fixture-continue-old-service"), priority);
    }
    else if (action === "cleanup") await cleanupOta(id);
    else throw Error("Unsupported OTA action");
    return 0;
  }
  if (command === "integrations") {
    if (!id || options.size !== 1 || positionals.length || separator >= 0 || flags.size) throw Error("usage: live integrations --id <id>");
    await exerciseIntegrations(loadSession(id));
    return 0;
  }
  if (command === "repair") {
    if (!id || options.size !== 1 || positionals.length || separator >= 0 || flags.size) throw Error("usage: live repair --id <id>");
    await exerciseRepair(loadSession(id));

    return 0;
  }
  if (command === "updater") {
    if (!id || options.size !== 1 || positionals.length || separator >= 0 || flags.size) throw Error("usage: live updater --id <id>");
    await exerciseUpdater(loadSession(id));
    return 0;
  }
  const session = loadSession(id);
  const env = sandboxEnv(session);
  switch (command) {
    case "env": process.stdout.write(environmentScript(session)); break;
    case "pacer":
    case "login": {
      if (command === "pacer" && (!forwarded.length || separator < 0)) throw Error("usage: live pacer [--id <id>] -- <args...>");
      const args = command === "pacer" ? forwarded : ["open", "--print", ...(options.has("--screen") ? [options.get("--screen")!] : [])];
      const result = await run([env.PACER_BIN!, ...args], session);
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      return result.code;
    }
    case "tui": console.log(await tui(session, positionals[0], positionals.slice(1), options.get("--out"))); break;
    case "desktop": console.log(desktop(session, options.get("--app"))); break;
    case "note": {
      const verdict = options.get("--verdict");
      if (verdict && !["PASS", "FAIL", "UNVERIFIED"].includes(verdict)) throw Error("verdict must be PASS, FAIL or UNVERIFIED");
      if (!positionals.length) throw Error("note requires observation text");
      record(session, { kind: "note", text: positionals.join(" "), behavior: options.get("--behavior"), surface: options.get("--surface"), steps: options.get("--steps"), verdict: verdict as "PASS" | "FAIL" | "UNVERIFIED" | undefined });
      break;
    }
    case "attach": {
      if (positionals.length !== 1) throw Error("attach requires one file path");
      const path = join(session.root, "evidence", `${Date.now()}-${basename(positionals[0])}`);
      copyFileSync(resolve(positionals[0]), path);
      chmodSync(path, 0o600);
      record(session, { kind: "attach", path });
      console.log(path);
      break;
    }
    case "report": {
      const path = join(session.root, "evidence/report.md");
      atomicWrite(path, renderReport(session, readEvidence(session)));
      console.log(path);
      break;
    }
    case "down": await down(session, flags.has("--keep")); break;
    default: throw Error(`Unknown command: ${command}\n${usage}`);
  }
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(`live: ${(error as Error).message}`); process.exitCode = 1; }
  // An OTA driver's event subscription and Desktop reference must not keep a finished
  // (or failed) exercise alive; the lease, not the driver, retires native participants.
  if (process.argv[2] === "ota") process.exit(process.exitCode);
}
