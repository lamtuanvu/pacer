import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildRelease, writeRelease } from "../scripts/release/build";
import { type Platform, assetFile, hostTarget } from "../src/update/manifest";
import { tmpDir } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");
const INSTALL_SH = join(ROOT, "install.sh");
const SHELL = Bun.which("dash") ?? "/bin/sh";
const PKG_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const MAC: Platform = { os: "darwin", arch: "arm64" };
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const body = (v: string, p: Platform) => `#!/bin/sh\n# ${p.os}-${p.arch}\necho "pacer ${v}"\n`;

function release(root: string, version: string, platforms: Platform[] = [MAC]): void {
  const dir = join(root, version);
  mkdirSync(dir, { recursive: true });
  for (const p of platforms) {
    const f = join(dir, assetFile(p));
    writeFileSync(f, body(version, p));
    chmodSync(f, 0o755);
  }
  writeRelease(root, version, platforms);
}

/** A PATH dir whose uname/sysctl pretend to be another machine. */
function fakeBin(s: string, m: string, translated = "0"): string {
  const d = join(tmpDir(), "fakebin");
  mkdirSync(d);
  writeFileSync(join(d, "uname"), `#!/bin/sh\ncase "$1" in\n  -m) echo "${m}" ;;\n  *) echo "${s}" ;;\nesac\n`);
  writeFileSync(join(d, "sysctl"), `#!/bin/sh\necho "${translated}"\n`);
  chmodSync(join(d, "uname"), 0o755);
  chmodSync(join(d, "sysctl"), 0o755);
  return d;
}

async function runInstall(env: Record<string, string>, bin: string | null = fakeBin("Darwin", "arm64")) {
  const PATH = bin ? `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` : (process.env.PATH ?? "/usr/bin:/bin");
  const p = Bun.spawn([SHELL, INSTALL_SH], { env: { HOME: tmpDir(), PATH, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

test("installs the latest release from a file:// base into PACER_INSTALL_DIR", async () => {
  const root = tmpDir();
  release(root, "0.1.0");
  release(root, "0.2.0");
  const dir = join(tmpDir(), "bin");
  const r = await runInstall({ PACER_RELEASE_BASE: `file://${root}/`, PACER_INSTALL_DIR: dir });
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(readFileSync(join(dir, "pacer"), "utf8")).toBe(body("0.2.0", MAC));
  expect(r.out).toContain(`installed: pacer 0.2.0 (${dir}/pacer)`);
  expect(r.out).toContain("pacer init");
  expect(r.out).toContain("pacer install <planner>");
  expect(readdirSync(dir)).toEqual(["pacer"]);
});

test("defaults to $HOME/.local/bin and explains how to add it to PATH", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  const home = tmpDir();
  const r = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, HOME: home });
  expect(r.code).toBe(0);
  expect(readFileSync(join(home, ".local", "bin", "pacer"), "utf8")).toBe(body("0.2.0", MAC));
  expect(r.out).toContain(`${home}/.local/bin is not on your PATH`);
});

test("PACER_INSTALL_VERSION picks a version, accepts a leading v and rejects junk", async () => {
  const root = tmpDir();
  release(root, "0.1.0");
  release(root, "0.2.0");
  const dir = join(tmpDir(), "bin");
  const r = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: dir, PACER_INSTALL_VERSION: "v0.1.0" });
  expect(r.code).toBe(0);
  expect(readFileSync(join(dir, "pacer"), "utf8")).toBe(body("0.1.0", MAC));
  const bad = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: dir, PACER_INSTALL_VERSION: "../0.1.0" });
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("invalid version: ../0.1.0");
});

test("checksum mismatch installs nothing and leaves an existing pacer alone", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  appendFileSync(join(root, "0.2.0", "pacer-darwin-arm64"), "# tampered\n");
  const dir = join(tmpDir(), "bin");
  mkdirSync(dir);
  writeFileSync(join(dir, "pacer"), "old");
  const r = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: dir });
  expect(r.code).toBe(1);
  expect(r.err).toContain("checksum mismatch for pacer-darwin-arm64");
  expect(r.err).toContain("nothing was installed");
  expect(readFileSync(join(dir, "pacer"), "utf8")).toBe("old");
  expect(readdirSync(dir)).toEqual(["pacer"]);
});

test("staged binary must run and report the requested version before replacing the installed binary", async () => {
  const root = tmpDir();
  const dir = join(tmpDir(), "bin");
  release(root, "0.2.0");
  writeFileSync(join(root, "0.2.0", "pacer-darwin-arm64"), "#!/bin/sh\necho 'pacer 9.9.9'\n");
  chmodSync(join(root, "0.2.0", "pacer-darwin-arm64"), 0o755);
  writeRelease(root, "0.2.0", [MAC]);
  mkdirSync(dir);
  writeFileSync(join(dir, "pacer"), "old binary\n");
  const r = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: dir });
  expect(r.code).toBe(1);
  expect(r.err).toContain("expected 'pacer 0.2.0'");
  expect(readFileSync(join(dir, "pacer"), "utf8")).toBe("old binary\n");
  expect(readdirSync(dir)).toEqual(["pacer"]);
});

test("installer rejects bases with query or fragment components", async () => {
  for (const base of ["file:///tmp/release?x=1", "https://example.com/releases#latest"]) {
    const r = await runInstall({ PACER_RELEASE_BASE: base });
    expect(r.code).toBe(1);
    expect(r.err).toContain("must not contain ? or #");
  }
});

test("downloader arguments forbid unsafe curl redirect schemes and wget redirects", () => {
  const script = readFileSync(INSTALL_SH, "utf8");
  expect(script).toContain("curl --proto '=https,http,file' --proto-redir '=https' -fsSL");
  expect(script).toContain("wget --max-redirect=0");
});

test("missing or insecure base is refused", async () => {
  const none = await runInstall({});
  expect(none.code).toBe(1);
  expect(none.err).toContain("PACER_RELEASE_BASE is not set");
  expect(none.err).toContain("file:///path/to/pacer/dist/release");
  const http = await runInstall({ PACER_RELEASE_BASE: "http://example.com/pacer" });
  expect(http.code).toBe(1);
  expect(http.err).toContain("must start with https://");
});

test("unsupported OS or CPU is reported", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  const os = await runInstall({ PACER_RELEASE_BASE: `file://${root}` }, fakeBin("FreeBSD", "amd64"));
  expect(os.code).toBe(1);
  expect(os.err).toContain("unsupported OS: FreeBSD");
  const cpu = await runInstall({ PACER_RELEASE_BASE: `file://${root}` }, fakeBin("Linux", "riscv64"));
  expect(cpu.code).toBe(1);
  expect(cpu.err).toContain("unsupported CPU: riscv64");
});

test("Rosetta shells get the arm64 build; Linux aarch64 maps to linux-arm64", async () => {
  const all: Platform[] = [MAC, { os: "darwin", arch: "x64" }, { os: "linux", arch: "arm64" }];
  const root = tmpDir();
  release(root, "0.2.0", all);
  const d1 = join(tmpDir(), "bin");
  const rosetta = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: d1 }, fakeBin("Darwin", "x86_64", "1"));
  expect(rosetta.code).toBe(0);
  expect(readFileSync(join(d1, "pacer"), "utf8")).toBe(body("0.2.0", MAC));
  const d2 = join(tmpDir(), "bin");
  const intel = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: d2 }, fakeBin("Darwin", "x86_64", "0"));
  expect(readFileSync(join(d2, "pacer"), "utf8")).toBe(body("0.2.0", { os: "darwin", arch: "x64" }));
  expect(intel.code).toBe(0);
  const d3 = join(tmpDir(), "bin");
  const linux = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: d3 }, fakeBin("Linux", "aarch64"));
  expect(linux.code).toBe(0);
  expect(readFileSync(join(d3, "pacer"), "utf8")).toBe(body("0.2.0", { os: "linux", arch: "arm64" }));
});

test("a release without a build for this platform says so", async () => {
  const root = tmpDir();
  release(root, "0.2.0", [MAC]);
  const r = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: join(tmpDir(), "bin") }, fakeBin("Linux", "x86_64"));
  expect(r.code).toBe(1);
  expect(r.err).toContain("release 0.2.0 has no build for linux-x64");
});

test.skipIf(!Bun.which("curl"))("downloads over loopback http with curl", async () => {
  const root = tmpDir();
  release(root, "0.2.0");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const f = Bun.file(join(root, decodeURIComponent(new URL(req.url).pathname)));
      return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const dir = join(tmpDir(), "bin");
  const r = await runInstall({ PACER_RELEASE_BASE: String(server.url), PACER_INSTALL_DIR: dir });
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(readFileSync(join(dir, "pacer"), "utf8")).toBe(body("0.2.0", MAC));
});

test.skipIf(!Bun.which("shellcheck"))("install.sh passes shellcheck as POSIX sh", () => {
  const r = Bun.spawnSync(["shellcheck", "-s", "sh", INSTALL_SH]);
  expect(r.stdout.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});

test.skipIf(!hostTarget())("installs a real compiled host build", async () => {
  const root = tmpDir();
  await buildRelease({ root: ROOT, outRoot: root, targets: [hostTarget()!] });
  const dir = join(tmpDir(), "bin");
  const r = await runInstall({ PACER_RELEASE_BASE: `file://${root}`, PACER_INSTALL_DIR: dir }, null);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`installed: pacer ${PKG_VERSION} (${dir}/pacer)`);
  expect(Bun.spawnSync([join(dir, "pacer"), "--version"]).stdout.toString().trim()).toBe(`pacer ${PKG_VERSION}`);
}, 180_000);
