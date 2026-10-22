import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileCommand, compileFrontDoor } from "../release/build";
import { assetFile, companionFile, hostTarget, sha256Hex } from "../../src/update/manifest";
import { checkout, record, type Session } from "./core";
import { updaterFixtureRoot } from "./updater";

/** Fixed fresh install, paired update and single-binary bridge downgrade; no manager effects. */
export async function exercisePairInstall(session: Session): Promise<void> {
  updaterFixtureRoot(session);
  const root = join(session.root, "repair"), build = join(root, "build");
  const target = hostTarget();
  if (!target) throw Error("Unsupported paired install fixture target");
  const bridge = "0.0.1", version = "0.0.2", next = "0.0.3", nextFront = join(build, "next-front"), nextCore = join(build, "next-core");
  const home = join(root, "paired-install-home"), temporary = join(root, "paired-install-tmp"), bin = join(home, ".local/bin");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(temporary, { mode: 0o700 }); mkdirSync(join(home, ".local"), { mode: 0o700 }); mkdirSync(bin, { mode: 0o700 });
  const env = { HOME: home, PACER_HOME: join(home, ".pacer"), TMPDIR: temporary,
    PATH: `${join(session.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C", PACER_NO_UPDATE_CHECK: "1" };
  const run = async (argv: string[], extra: Record<string, string> = {}, expectedCode = 0) => {
    const child = Bun.spawn(argv, { cwd: root, env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120000 });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    record(session, { kind: "command", argv, code, stdout, stderr });
    if (code !== expectedCode) throw Error(`Paired fixture command failed (${code}): ${stderr}`);
    return stdout;
  };
  await run(compileCommand({ root: checkout, target, version: next, outfile: nextCore }));
  await compileFrontDoor({ root: checkout, target, version: next, outfile: nextFront });
  const files = new Map<string, string | Buffer>();
  const contents = [[version, join(build, "pacer"), join(build, "new-core")], [next, nextFront, nextCore]];
  for (const [v, frontPath, corePath] of contents) {
    const front = readFileSync(frontPath), core = readFileSync(corePath), file = assetFile(target), companion = companionFile(target);
    files.set(`/${v}/${file}`, front); files.set(`/${v}/${companion}`, core);
    files.set(`/${v}/SHA256SUMS`, `${sha256Hex(front)}  ${file}\n${sha256Hex(core)}  ${companion}\n`);
    files.set(`/${v}/manifest.json`, JSON.stringify({ version: v, assets: [{ os: target.os, arch: target.arch, file, size: front.length, sha256: sha256Hex(front),
      companions: [{ name: "pacer-core", file: companion, size: core.length, sha256: sha256Hex(core) }] }] }));
  }
  // The existing compiled OLD core is a real single Bun CLI, matching the
  // bridge release shape: one asset and deliberately no companions property.
  const bridgeBytes = readFileSync(join(build, "old-core")), bridgeFile = assetFile(target);
  files.set(`/${bridge}/${bridgeFile}`, bridgeBytes);
  files.set(`/${bridge}/SHA256SUMS`, `${sha256Hex(bridgeBytes)}  ${bridgeFile}\n`);
  files.set(`/${bridge}/manifest.json`, JSON.stringify({ version: bridge, assets: [{
    os: target.os, arch: target.arch, file: bridgeFile, size: bridgeBytes.length, sha256: sha256Hex(bridgeBytes),
  }] }));
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    const data = files.get(path);
    return request.method === "GET" && data !== undefined ? new Response(typeof data === "string" ? data : new Uint8Array(data)) : new Response("not found", { status: 404 });
  } });
  if (server.port === 4317) { server.stop(true); throw Error("Refusing default service port"); }
  const base = `http://127.0.0.1:${server.port}`, front = join(bin, "pacer"), core = join(bin, "pacer-core");
  const hash = (path: string) => sha256Hex(readFileSync(path));
  const must = (condition: boolean, message: string) => { if (!condition) throw Error(message); };
  try {
    await run(["/bin/sh", join(checkout, "install.sh")], { PACER_RELEASE_BASE: base, PACER_INSTALL_VERSION: version, PACER_INSTALL_DIR: bin });
    must(hash(front) === hash(join(build, "pacer")) && hash(core) === hash(join(build, "new-core")), "Shell installer did not install the exact verified pair");
    const preload = join(root, "startup-preload.js"), marker = join(root, "startup-preload-ran");
    writeFileSync(preload, `await Bun.write(${JSON.stringify(marker)}, "preloaded");\n`, { mode: 0o600, flag: "wx" });
    const preloaded = { BUN_OPTIONS: "--preload ./startup-preload.js" };
    // Positive control proves the fixed preload is effective on this actual core.
    await run([core, "--help"], preloaded);
    must(existsSync(marker), "Startup fixture preload positive control did not run");
    unlinkSync(marker);
    await run([front, "--help"], preloaded);
    must(!existsSync(marker), "Ambient preload reached the core through the Rust front door");
    record(session, { kind: "note", behavior: "Compiled core startup environment", surface: "Rust CLI/version probe/Bun core", verdict: "PASS", text: "A fixed private preload executed in the direct compiled core positive control, then remained absent when the Rust front door checked and invoked that same core. Private HOME and fixture script only." });
    record(session, { kind: "note", behavior: "Fresh paired shell installation", surface: "install.sh/compiled CLI", verdict: "PASS", text: "Actual installer downloaded, checksum-verified and installed the compiled Rust front door and Bun core into a private prefix; the installed front door executed its sibling core." });
    const resources = join(root, "repair-boundary/pacer.app/Contents/Resources");
    mkdirSync(resources, { recursive: true, mode: 0o700 });
    const bundled = join(resources, "pacer");
    copyFileSync(front, bundled); chmodSync(bundled, 0o755);
    const before = requests.length;
    await run([bundled, "self-repair", "--base", base], {}, 1);
    await run([bundled, "route"], { PACER_RELEASE_BASE: base }, 1);
    must(requests.length === before && readdirSync(resources).join(",") === "pacer", "Desktop bundle core refusal downloaded or mutated resources");
    record(session, { kind: "note", behavior: "Complete-app core repair boundary", surface: "compiled Rust CLI", verdict: "PASS", text: "Actual front door in a fixed disposable app resource layout refused explicit and automatic partial core repair before downloads, staging, locks or resource changes. This path guard does not certify a signed desktop installation." });
    await run([front, "update", "--to", next, "--base", base, "--no-restart", "--no-reinstall"]);
    must(hash(front) === hash(nextFront) && hash(core) === hash(nextCore), "Self-update did not install the exact next pair");
    must(hash(`${front}.bak`) === hash(join(build, "pacer")) && hash(`${core}.bak`) === hash(join(build, "new-core")), "Self-update lost paired backups");
    must((await run([front, "--version"])).trim() === `pacer ${next}`, "Front door version did not advance");
    must((await run([core, "--version"])).trim() === `pacer ${next}`, "Core version did not advance");
    await run([front, "--help"]);
    must(readdirSync(bin).sort().join(",") === "pacer,pacer-core,pacer-core.bak,pacer.bak", "Unexpected paired staging files remain");
    must(requests.every(path => files.has(path)), "Fixture made unexpected release requests");
    record(session, { kind: "note", behavior: "Rust pair self-update", surface: "compiled CLI", verdict: "PASS", text: "Actual Rust front door invoked its Bun updater, replaced both installed binaries and retained exact paired backups; subsequent execution used the new core. Fixed loopback feed and private HOME; no integration refresh or service-manager changes." });
    const retainedCore = hash(core), retainedCoreBackup = hash(`${core}.bak`);
    const downgradeRequests = requests.length;
    await run([front, "update", "--to", bridge, "--base", base, "--no-restart", "--no-reinstall"]);
    must(hash(front) === sha256Hex(bridgeBytes), "Downgrade did not restore the exact single Bun bridge binary");
    must(hash(`${front}.bak`) === hash(nextFront), "Downgrade did not preserve the immediately previous Rust front door backup");
    must(hash(core) === retainedCore && hash(`${core}.bak`) === retainedCoreBackup, "Single-binary downgrade removed or modified a companion or its backup");
    must((await run([front, "--version"])).trim() === `pacer ${bridge}`, "Bridge CLI did not report the downgraded version");
    must((await run([core, "--version"])).trim() === `pacer ${next}`, "Stale companion version changed during downgrade");
    await run([front, "--help"]);
    must(readdirSync(bin).sort().join(",") === "pacer,pacer-core,pacer-core.bak,pacer.bak", "Downgrade left unexpected staging files or removed retained files");
    must(requests.slice(downgradeRequests).includes(`/${bridge}/manifest.json`) && requests.slice(downgradeRequests).includes(`/${bridge}/${bridgeFile}`), "Downgrade did not fetch its exact bridge manifest and asset");
    must(requests.slice(downgradeRequests).every(path => path.startsWith(`/${bridge}/`) && files.has(path)), "Bridge downgrade fetched a companion or another version");
    record(session, { kind: "note", behavior: "Paired CLI to single-binary bridge downgrade", surface: "compiled CLI", verdict: "PASS", text: "Actual installed Rust/Bun pair downgraded through its updater to the exact compiled single Bun bridge; front-door backup preserved the prior Rust bytes. Stale newer pacer-core and its earlier backup stayed byte-identical; bridge version/help succeeded despite the version mismatch. Fixed private loopback feed; no native app, service-manager or integration changes." });
  } catch (error) {
    record(session, { kind: "note", behavior: "Paired install/update/bridge downgrade", surface: "compiled CLI", verdict: "FAIL", text: (error as Error).message });
    throw error;
  } finally { server.stop(true); }
}
