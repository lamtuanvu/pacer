import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileCommand } from "../scripts/release/build";
import { hostTarget } from "../src/update/manifest";
import { tmpDir } from "./helpers";

async function run(argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  return { code, stdout, stderr };
}

test("compiled Core starts and reports its build version", async () => {
  const target = hostTarget();
  if (!target) throw new Error("compiled Core smoke requires a supported host");
  const root = resolve(import.meta.dir, "..");
  const dir = tmpDir();
  const outfile = join(dir, "pacer-core");
  try {
    const build = await run(compileCommand({ root, target, version: "0.10.0", outfile }), root);
    expect(build.code).toBe(0);
    if (build.code !== 0) throw new Error(build.stderr || build.stdout);
    const smoke = await run([outfile, "--version"], root);
    expect(smoke.code).toBe(0);
    expect(smoke.stdout.trim()).toBe("pacer 0.10.0");
    expect(smoke.stderr).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
