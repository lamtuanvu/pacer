import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { COMPILED_WORKERS, compileCommand } from "../scripts/release/build";
import { hostTarget } from "../src/update/manifest";
import { tmpDir } from "./helpers";

const root = resolve(import.meta.dir, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Files that start a URL worker; worker-location.ts defines the shared entry paths. */
function workerSources(): string[] {
  return sources(join(root, "src")).filter(file =>
    readFileSync(file, "utf8").includes("new Worker(") || file.endsWith("serve/worker-location.ts"));
}

test("every URL worker the service starts is a compile entrypoint", () => {
  // Source-relative worker URLs that exist on disk; the compiled-mode variants do not.
  const workers = workerSources().flatMap(file =>
    [...readFileSync(file, "utf8").matchAll(/new URL\("(\.\.?\/[^"]+\.ts)", (?:import\.meta\.url|metaURL)\)/g)]
      .map(match => resolve(dirname(file), match[1]!))
      .filter(path => existsSync(path))
      .map(path => relative(root, path).split("\\").join("/")));
  expect(workers.length).toBeGreaterThan(0);
  expect([...new Set(workers)].sort()).toEqual([...COMPILED_WORKERS].sort());
  const argv = compileCommand({ root, target: { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" }, version: "0.0.0", outfile: "/dev/null" } as Parameters<typeof compileCommand>[0]);
  for (const worker of COMPILED_WORKERS) expect(argv).toContain(join(root, ...worker.split("/")));
});

async function run(argv: string[], cwd: string, timeoutMs = 30000, env = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  let deadline: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => { deadline = setTimeout(() => { process.kill(); reject(new Error(`compiled smoke timed out: ${argv.join(" ")}`)); }, timeoutMs); });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(),
      Promise.race([process.exited, timer]),
    ]);
    return { code, stdout, stderr };
  } finally { clearTimeout(deadline!); }
}

test("both service workers start inside a compiled binary", async () => {
  // A source run resolves ./background-worker.ts, but a compiled binary must
  // resolve ./serve/background-worker.ts (its entry is /$bunfs/root/<file>).
  const target = hostTarget();
  if (!target) throw new Error("compiled worker smoke requires a supported host");
  const dir = tmpDir();
  const outfile = join(dir, "pacer-bg-worker-probe");
  // Keep every entry under src/, matching the release build's common root.
  const probe = join(root, "src", ".compiled-worker-probe.ts");
  writeFileSync(probe, readFileSync(join(root, "test", "fixtures", "background-worker-probe.ts"), "utf8")
    .replace("../../src/serve/worker-location", "./serve/worker-location"));
  const argv = compileCommand({ root, target, version: "0.0.0", outfile });
  argv[argv.indexOf(join(root, "src", "cli.ts"))] = probe;
  try {
    const build = await run(argv, root, 120000);
    expect(build.code).toBe(0);
    if (build.code !== 0) throw new Error(build.stderr || build.stdout);
    const smoke = await run([outfile], root, 60000, { ...process.env, HOME: dir, PACER_HOME: join(dir, "home") });
    expect(smoke.code).toBe(0);
    expect(smoke.stdout).toContain("BACKGROUND_HEARTBEAT_OK");
    expect(smoke.stdout).toContain("SUPERVISION_HEARTBEAT_OK");
    expect(smoke.stderr).not.toContain("WORKER_FAILED");
    expect(smoke.stderr).not.toContain("WORKER_ERROR");
  } finally {
    rmSync(probe, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
