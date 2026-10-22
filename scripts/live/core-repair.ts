import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileCommand, compileFrontDoor } from "../release/build";
import { assetFile, companionFile, hostTarget, sha256Hex } from "../../src/update/manifest";
import { findIdentity } from "../../src/update/signing";
import { checkout, healthy, record, type Session } from "./core";
import { updaterFixtureRoot } from "./updater";

const OLD = "0.0.1", VERSION = "0.0.2";
const scenarios = ["missing", "mismatch", "checksum", "smoke", "disabled", "readonly"] as const;

/** A fixed mode for disposable core repair; ordinary guarded commands gain no write authority. */
export function repairFixtureRoot(session: Session): string {
  updaterFixtureRoot(session); // Same canonical ownership, evidence and active seed requirements.
  return join(session.root, "repair");
}

export async function exerciseRepair(session: Session): Promise<void> {
  const root = repairFixtureRoot(session);
  if (!await healthy(session)) throw Error("Repair fixture requires the live service and guard proxy");
  const target = hostTarget();
  if (!target) throw Error("Unsupported repair fixture platform");
  const noSigningKey = async () => {
    if (process.platform === "darwin" && await findIdentity()) throw Error("Repair fixture refuses a real local signing identity; use a test account without that identity");
  };
  await noSigningKey();
  mkdirSync(root, { mode: 0o700 }); // Exclusive; never reuse partial fixture state.
  const build = join(root, "build"), buildHome = join(root, "build-home"), buildTmp = join(root, "build-tmp");
  for (const dir of [build, buildHome, buildTmp]) mkdirSync(dir, { mode: 0o700 });
  const frontBuild = join(build, "pacer"), oldCore = join(build, "old-core"), newCore = join(build, "new-core");
  for (const [version, outfile] of [[OLD, oldCore], [VERSION, newCore]]) {
    const argv = compileCommand({ root: checkout, target, version, outfile });
    const child = Bun.spawn(argv, { cwd: checkout, env: { HOME: buildHome, TMPDIR: buildTmp, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe", timeout: 120000 });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    record(session, { kind: "command", argv, code, stdout, stderr });
    if (code !== 0) throw Error(`Cannot compile repair fixture: ${stderr}`);
  }
  await compileFrontDoor({ root: checkout, target, version: VERSION, outfile: frontBuild });
  const frontHash = sha256Hex(readFileSync(frontBuild)), oldHash = sha256Hex(readFileSync(oldCore));
  const currentBytes = readFileSync(newCore);
  record(session, { kind: "note", text: `Repair build provenance: front door sha256=${frontHash}; core sha256=${sha256Hex(currentBytes)}; fixture version=${VERSION}.` });
  for (const scenario of scenarios) {
    const directory = join(root, scenario), bin = join(directory, "bin"), home = join(directory, "home"), temporary = join(directory, "tmp");
    mkdirSync(directory, { mode: 0o700 });
    for (const dir of [bin, home, temporary]) mkdirSync(dir, { mode: 0o700 });
    const front = join(bin, "pacer"), core = join(bin, "pacer-core");
    copyFileSync(frontBuild, front);
    const previous = ["mismatch", "checksum", "smoke"].includes(scenario);
    if (previous) copyFileSync(oldCore, core);
    const bytes = scenario === "smoke" ? readFileSync(oldCore) : currentBytes;
    const file = companionFile(target);
    const manifest = { version: VERSION, assets: [{ os: target.os, arch: target.arch, file: assetFile(target), size: 1, sha256: frontHash,
      companions: [{ name: "pacer-core", file, size: bytes.length, sha256: sha256Hex(bytes) }] }] };
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      requests++;
      if (request.method !== "GET") return new Response("refused", { status: 405 });
      const path = new URL(request.url).pathname;
      if (path === `/${VERSION}/manifest.json`) return Response.json(manifest);
      if (path === `/${VERSION}/${file}`) return new Response(new Uint8Array(scenario === "checksum" ? Buffer.alloc(bytes.length, 120) : bytes));
      return new Response("not found", { status: 404 });
    } });
    if (server.port === 4317) { server.stop(true); throw Error("Refusing default service port"); }
    const env = {
      HOME: home, PACER_HOME: join(home, ".pacer"), TMPDIR: temporary,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
      PATH: `${join(session.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C", PACER_BIN: front, PACER_PORT: String(session.port),
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: scenario === "disabled" ? "1" : "0", PACER_RELEASE_BASE: `http://127.0.0.1:${server.port}`,
    };
    const run = async () => {
      const argv = [front, "--help"];
      const child = Bun.spawn(argv, { cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 90000 });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      record(session, { kind: "command", argv, code, stdout, stderr });
      return { code, stdout, stderr };
    };
    const must = (condition: boolean, message: string) => { if (!condition) throw Error(`${scenario}: ${message}`); };
    try {
      await noSigningKey();
      if (scenario === "readonly") chmodSync(bin, 0o555);
      const result = await run();
      writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
      if (scenario === "missing" || scenario === "mismatch") {
        must(result.code === 0, `repair/exec failed: ${result.stderr}`);
        must(sha256Hex(readFileSync(core)) === sha256Hex(currentBytes), "installed core differs from verified release bytes");
        must(requests === 2, "did not fetch exactly the own-version manifest and core");
        must((await run()).code === 0 && requests === 2, "cached repair repeated the download or failed");
      } else {
        must(result.code !== 0, "failure scenario unexpectedly succeeded");
        if (previous) must(sha256Hex(readFileSync(core)) === oldHash, "failed repair changed old core");
        else must(!existsSync(core), "disabled or readonly repair created a core");
        if (scenario === "disabled" || scenario === "readonly") must(requests === 0 && result.stderr.includes("pacer-core is missing"), "disabled/readonly repair contacted the feed or lost diagnostic");
      }
      must(sha256Hex(readFileSync(front)) === frontHash, "repair changed the front door");
      must(readdirSync(bin).every(name => ["pacer", "pacer-core", ".pacer-core-repair.lock"].includes(name)), "staging files remain");
      await noSigningKey();
      record(session, { kind: "note", behavior: `Core self-repair: ${scenario}`, surface: "compiled CLI", verdict: "PASS", text: `Actual Rust front door and compiled Bun core; fixed own-version loopback feed, private HOME, unchanged front door, ${requests} feed requests.` });
    } catch (error) {
      record(session, { kind: "note", behavior: `Core self-repair: ${scenario}`, surface: "compiled CLI", verdict: "FAIL", text: (error as Error).message });
      throw error;
    } finally { chmodSync(bin, 0o700); server.stop(true); }
  }
  // Exercise all client transports against these same compiled bytes. The test
  // creates only disposable services and a deterministic Unix-socket peer,
  // underneath this fixture's private TMPDIR; it delegates no executor work.
  copyFileSync(newCore, join(build, "pacer-core"));
  const argv = [process.execPath, "test", "test/transport-parity.test.ts"];
  const child = Bun.spawn(argv, { cwd: checkout, env: {
    HOME: buildHome, PACER_HOME: join(buildHome, ".pacer"), TMPDIR: buildTmp,
    PATH: `${join(session.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, TZ: "Asia/Ho_Chi_Minh",
    PACER_TEST_FRONT_DOOR: frontBuild, PACER_NO_UPDATE_CHECK: "1",
  }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  record(session, { kind: "command", argv, code, stdout, stderr });
  const output = stdout + stderr;
  const pass = code === 0 && /\b1 pass\b/.test(output) && /\b0 fail\b/.test(output) && !/\b[1-9]\d* skip\b/.test(output);
  record(session, { kind: "note", behavior: "Compiled client transport parity", surface: "HTTP/stdio/SSE/WebSocket",
    verdict: pass ? "PASS" : "FAIL", text: "Actual paired Rust/Bun artifacts compared over stdio, bearer/cookie auth, rejection headers, SSE and binary/control WebSocket frames; fixed private services and Unix peer, no executor delegation." });
  if (!pass) throw Error(`Compiled transport parity failed: ${stderr}`);
}
