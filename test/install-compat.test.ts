import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { uninstallPlanner } from "../src/install/uninstall";
import { readManifest, type Manifest } from "../src/install/manifest";
import { sha256 } from "../src/install/fsx";
import type { Ctx } from "../src/types";

interface FileImage { text: string; mode: number }
interface Fixture {
  schema: 1;
  agent: string;
  now: number;
  pacerArgv: string[];
  before: Record<string, FileImage>;
  after: Record<string, FileImage>;
  manifest: Manifest;
  installCalls: string[][];
  uninstall: { report: Awaited<ReturnType<typeof uninstallPlanner>>; calls: string[][] };
  unrelatedEdit: { path: string; append: string };
}
function setup(agent: string) {
  const raw = readFileSync(join(import.meta.dir, "fixtures/install", `${agent}.json`), "utf8");
  expect(raw).not.toMatch(/\/(?:Users|Volumes)\//);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pacer-install-replay-"))), pacerHome = join(home, ".pacer");
  const fixture = JSON.parse(raw.replaceAll("$PACER_HOME", pacerHome).replaceAll("$HOME", home)) as Fixture;
  const calls: string[][] = [];
  const ctx: Ctx = { home, pacerHome, now: fixture.now, env: { HOME: home, PACER_HOME: pacerHome },
    which: name => `/fixture/bin/${name}`,
    run: async argv => { calls.push([...argv]); return { code: 0, stdout: "", stderr: "" }; },
  };
  mkdirSync(pacerHome, { mode: 0o700 });
  for (const [path, image] of Object.entries(fixture.after)) {
    if (!path.startsWith(home + "/")) throw Error("fixture path escapes owned home");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, image.text, { mode: image.mode }); chmodSync(path, image.mode);
  }
  writeFileSync(join(pacerHome, "install-manifest.json"), JSON.stringify(fixture.manifest, null, 2) + "\n", { mode: 0o600 });
  const snapshot = () => {
    const files: Record<string, FileImage> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (path === pacerHome) continue;
        if (entry.isDirectory()) walk(path);
        else files[path] = { text: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 };
      }
    };
    walk(home); return files;
  };
  return { home, ctx, calls, fixture, snapshot };
}

for (const agent of ["claude-code", "codex", "cursor", "opencode"]) {
  test(`${agent} recorded host install uninstalls to exact original bytes and file modes`, async () => {
    const f = setup(agent);
    try {
      expect(f.fixture.schema).toBe(1);
      expect(f.fixture.manifest.planners[agent]!.pacerArgv).toEqual(["pacer"]);
      // Captured real hashes remain valid after relocating the root; no hash repair.
      for (const file of f.fixture.manifest.planners[agent]!.files) {
        if (file.afterHash) expect(sha256(readFileSync(file.path, "utf8"))).toBe(file.afterHash);
      }
      expect(await uninstallPlanner(f.ctx, agent)).toEqual(f.fixture.uninstall.report);
      expect(f.calls).toEqual(f.fixture.uninstall.calls);
      expect(f.snapshot()).toEqual(f.fixture.before);
      expect(readManifest(f.ctx)).toEqual({ version: 1, planners: {} });
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  });
  test(`${agent} recorded undo preserves a user edit made after install`, async () => {
    const f = setup(agent);
    try {
      const { path, append } = f.fixture.unrelatedEdit;
      appendFileSync(path, append);
      const beforeMode = statSync(path).mode & 0o777;
      const report = await uninstallPlanner(f.ctx, agent);
      expect(report!.reverted).toContain(path);
      expect(readFileSync(path, "utf8")).toContain(append.trim());
      expect(readFileSync(path, "utf8")).not.toContain(">>> pacer >>>");
      expect(statSync(path).mode & 0o777).toBe(beforeMode);
      expect(readFileSync(join(f.home, "unrelated.txt"), "utf8")).toBe("Unrelated fixture content: 界\n");
      expect(readManifest(f.ctx).planners).toEqual({});
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  });
}
