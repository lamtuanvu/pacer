import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileCommand } from "../release/build";
import { assetFile, companionFile, hostTarget, sha256Hex } from "../../src/update/manifest";
import { findIdentity } from "../../src/update/signing";
import { checkout, healthy, liveRoot, record, shellQuote, validId, type Session } from "./core";

const OLD = "0.0.1", NEXT = "0.0.2";
const scenarios = ["pair", "new-companion", "legacy", "checksum", "smoke", "rollback"] as const;
type Scenario = typeof scenarios[number];

/** This fixed fixture mode grants no authority to ordinary guarded update calls. */
export function updaterFixtureRoot(session: Session): string {
  const expected = join(liveRoot, validId(session.id));
  if (session.root !== expected || session.seed !== "ui" || session.stopped) {
    throw Error("Updater fixture requires an active seeded live sandbox");
  }
  for (const path of [checkout, join(checkout, ".work"), liveRoot, expected, join(expected, "evidence")]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
        || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) {
      throw Error("Updater fixture requires owned, canonical, non-writable-by-others directories");
    }
  }
  const log = join(expected, "evidence/log.jsonl");
  if (existsSync(log)) {
    const stat = lstatSync(log);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw Error("Updater fixture evidence must be a private regular file");
  }
  return join(expected, "updater");
}

export function rollbackProbe(front: string): Buffer {
  return Buffer.from(`#!/bin/sh\n[ "$0" = ${shellQuote(`${front}.new`)} ] || exit 9\n/bin/rm -f -- "$0"\nprintf 'pacer ${NEXT}\\n'\n`);
}

export async function exerciseUpdater(session: Session): Promise<void> {
  const root = updaterFixtureRoot(session);
  if (!await healthy(session)) throw Error("Updater fixture requires the live service and guard proxy");
  mkdirSync(root, { mode: 0o700 }); // Exclusive: never reuse a partially exercised fixture.
  const build = join(root, "build"); mkdirSync(build, { mode: 0o700 });
  const target = hostTarget();
  if (!target) throw Error("Unsupported updater fixture platform");
  const baseline = join(build, "baseline"), candidate = join(build, "candidate");
  const buildHome = join(build, "home"), buildTmp = join(build, "tmp");
  mkdirSync(buildHome, { mode: 0o700 }); mkdirSync(buildTmp, { mode: 0o700 });
  // The updater's actual signing path must find no local private signing key.
  // Read-only identity metadata is consulted; this is not a keychain-free test.
  const noSigningKey = async () => {
    if (process.platform === "darwin" && await findIdentity()) throw Error("Updater fixture refuses a real local signing identity; use a test account without that identity");
  };
  await noSigningKey();
  for (const [version, outfile] of [[OLD, baseline], [NEXT, candidate]]) {
    const argv = compileCommand({ root: checkout, target, version, outfile });
    const child = Bun.spawn(argv, { cwd: checkout, env: { HOME: buildHome, TMPDIR: buildTmp, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe", timeout: 120000 });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    record(session, { kind: "command", argv, code, stdout, stderr });
    if (code !== 0) throw Error(`Could not compile updater fixture: ${stderr}`);
  }
  const oldHash = sha256Hex(readFileSync(baseline));
  const newBytes = readFileSync(candidate);
  for (const scenario of scenarios) {
    try {
      await noSigningKey();
      await exercise(scenario);
      await noSigningKey();
      record(session, { kind: "note", behavior: `Companion updater: ${scenario}`, surface: "compiled CLI", verdict: "PASS", text: `Real compiled updater exercised ${scenario} against disposable files, fixed loopback release and isolated HOME. No integration refresh or service restart.` });
    } catch (error) {
      record(session, { kind: "note", behavior: `Companion updater: ${scenario}`, surface: "compiled CLI", verdict: "FAIL", text: (error as Error).message });
      throw error;
    }
  }
  async function exercise(scenario: Scenario): Promise<void> {
    const directory = join(root, scenario); mkdirSync(directory, { mode: 0o700 });
    const bin = join(directory, "bin"), home = join(directory, "home"), temporary = join(directory, "tmp");
    for (const path of [bin, home, temporary]) mkdirSync(path, { mode: 0o700 });
    const front = join(bin, "pacer"), core = join(bin, "pacer-core");
    copyFileSync(baseline, front);
    if (scenario !== "new-companion") copyFileSync(baseline, core);
    // A fixed failure probe removes only its own known staged fixture path. It
    // passes the version check, then the real front-door commit rename fails,
    // after the real updater has already installed the core.
    const brokenFront = rollbackProbe(front);
    const badSmoke = Buffer.from("#!/bin/sh\nprintf 'pacer 0.0.0\\n'\n");
    const frontBytes = scenario === "rollback" ? brokenFront : newBytes;
    const coreBytes = scenario === "smoke" ? badSmoke : newBytes;
    const file = assetFile(target!), companion = companionFile(target!);
    const entries = [{ file, bytes: frontBytes }, ...(scenario === "legacy" ? [] : [{ file: companion, bytes: coreBytes }])];
    const manifest = {
      version: NEXT,
      assets: [{
        os: target!.os, arch: target!.arch, file,
        size: frontBytes.length, sha256: sha256Hex(frontBytes),
        ...(scenario === "legacy" ? {} : {
          companions: [{ name: "pacer-core", file: companion, size: coreBytes.length, sha256: sha256Hex(coreBytes) }],
        }),
      }],
    };
    const files = new Map<string, string | Buffer>([
      [`/${NEXT}/manifest.json`, JSON.stringify(manifest)],
      [`/${NEXT}/SHA256SUMS`, entries.map(entry => `${sha256Hex(entry.bytes)}  ${entry.file}\n`).join("")],
      ...entries.map(entry => [`/${NEXT}/${entry.file}`, entry.bytes] as [string, Buffer]),
    ]);
    if (scenario === "checksum") files.set(`/${NEXT}/${companion}`, Buffer.alloc(coreBytes.length, 120));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const value = files.get(new URL(req.url).pathname);
      return req.method === "GET" && value !== undefined ? new Response(typeof value === "string" ? value : new Uint8Array(value)) : new Response("not found", { status: 404 });
    } });
    if (server.port === 4317) { server.stop(true); throw Error("Refusing default service port"); }
    const env = {
      HOME: home, PACER_HOME: join(home, ".pacer"), TMPDIR: temporary,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"), PACER_BIN: front,
      PACER_PORT: String(session.port), PACER_NO_UPDATE_CHECK: "1",
      PATH: `${join(session.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C",
    };
    const argv = [front, "update", "--to", NEXT, "--base", `http://127.0.0.1:${server.port}`, "--no-restart", "--no-reinstall"];
    try {
      const child = Bun.spawn(argv, { cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120000 });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      record(session, { kind: "command", argv, code, stdout, stderr });
      writeFileSync(join(directory, "result.json"), JSON.stringify({ code, stdout, stderr }, null, 2), { mode: 0o600 });
      const must = (condition: boolean, message: string) => { if (!condition) throw Error(`${scenario}: ${message}\n${stderr}\n${stdout}`); };
      const hash = (path: string) => sha256Hex(readFileSync(path));
      const version = async (path: string) => {
        const process = Bun.spawn([path, "--version"], { cwd: directory, env, stdout: "pipe", stderr: "pipe", timeout: 15000 });
        const output = await new Response(process.stdout).text();
        must(await process.exited === 0, "version probe failed"); return output.trim().split(/\s+/).at(-1);
      };
      if (["pair", "new-companion", "legacy"].includes(scenario)) {
        must(code === 0, "update failed");
        must(await version(front) === NEXT, "front door did not advance");
        must(hash(`${front}.bak`) === oldHash, "front backup differs");
        must(await version(core) === (scenario === "legacy" ? OLD : NEXT), "unexpected companion version");
        if (scenario === "pair") must(hash(`${core}.bak`) === oldHash, "core backup differs");
        if (scenario === "new-companion") must(!existsSync(`${core}.bak`), "invented a missing core backup");
      } else {
        const expected = scenario === "checksum" ? "checksum mismatch" : scenario === "smoke" ? "did not report version" : "could not replace pair";
        must(code !== 0 && stderr.includes(expected), `expected ${expected}`);
        must(hash(front) === oldHash && hash(core) === oldHash, "failed update changed installed bytes");
        must(await version(front) === OLD && await version(core) === OLD, "failed update changed versions");
        if (scenario === "rollback") must(existsSync(`${front}.bak`) && !existsSync(`${core}.bak`), "core backup was not consumed by rollback");
      }
      must(!existsSync(`${front}.new`) && !existsSync(`${core}.new`), "staging files remain");
    } finally { server.stop(true); }
  }
}
