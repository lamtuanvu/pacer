import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./helpers";

const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
const script = workflow.split("      - name: Publish Orca plugin bundle\n")[1].split("\n  npm:")[0].split("        run: |\n")[1]
  .split("\n").map(line => line.replace(/^          /, "")).join("\n");

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

test("plugin release publishes a root bundle, preserves branch history and refuses existing tags", () => {
  const root = tmpDir(), remote = join(root, "remote.git"), checkout = join(root, "checkout");
  git(root, "init", "--bare", remote);
  mkdirSync(checkout);
  mkdirSync(join(checkout, "orca-plugin"));
  cpSync(resolve("orca-plugin/dist"), join(checkout, "orca-plugin/dist"), { recursive: true });
  for (const name of ["LICENSE", "NOTICE"]) cpSync(resolve(name), join(checkout, name));
  const release = (version: string, manifestVersion = version, dryRun = false) => {
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(checkout, "orca-marketplace.json"), JSON.stringify({ plugins: [{ id: "lamtuanvu.pacer", source: { ref: `orca-plugin-v${version}` } }] }));
    const manifestPath = join(checkout, "orca-plugin/dist/orca-plugin.json");
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version: manifestVersion }));
    return Bun.spawnSync(["bash", "-c", script], {
      cwd: checkout, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, VERSION: version, DRY_RUN: String(dryRun), GH_TOKEN: "test-only", GITHUB_REPOSITORY: "fixture/pacer", GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/fixture/pacer.git" },
    });
  };
  expect(release("1.0.0", "1.0.0", true).exitCode).toBe(0);
  expect(git(remote, "for-each-ref")).toBe("");
  expect(release("1.0.0").exitCode).toBe(0);
  const first = git(remote, "rev-parse", "orca-plugin");
  expect(git(remote, "ls-tree", "--name-only", "orca-plugin").split("\n")).toEqual(["LICENSE", "NOTICE", "assets", "orca-plugin.json", "panel", "worker.mjs"]);
  expect(git(remote, "cat-file", "-t", "orca-plugin-v1.0.0")).toBe("tag");
  expect(JSON.parse(git(remote, "show", "orca-plugin-v1.0.0:orca-plugin.json")).version).toBe("1.0.0");
  expect(release("1.0.1").exitCode).toBe(0);
  const second = git(remote, "rev-parse", "orca-plugin");
  expect(git(remote, "rev-parse", "orca-plugin^" )).toBe(first);
  expect(git(remote, "show", "-s", "--format=%s", "orca-plugin")).toBe("release: orca plugin 1.0.1");
  expect(release("1.0.1").exitCode).not.toBe(0);
  expect(release("1.0.2", "1.0.1").exitCode).not.toBe(0);
  expect(git(remote, "rev-parse", "orca-plugin")).toBe(second);
  expect(git(remote, "tag", "--list")).toBe("orca-plugin-v1.0.0\norca-plugin-v1.0.1");
  expect(readdirSync(checkout)).toContain("package.json");
});
