import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { versionFromDescription } from "../scripts/build";
import { tmpDir } from "./helpers";

test("local build versions combine package version and git describe", () => {
  expect(versionFromDescription("0.2.3", "v0.2.3-12-gabc1234")).toBe("0.2.3+12.gabc1234");
  expect(versionFromDescription("0.2.4", "v0.2.3-12-gabc1234")).toBe("0.2.4+12.gabc1234");
  expect(versionFromDescription("0.2.3", "v0.2.3-0-gabc1234")).toBe("0.2.3");
  expect(versionFromDescription("0.2.3", "v0.2.3-0-gabc1234-dirty")).toBe("0.2.3+0.gabc1234.dirty");
  expect(versionFromDescription("0.2.3", "abc1234")).toBe("0.2.3+gabc1234");
  expect(versionFromDescription("0.2.3", "abc1234-dirty")).toBe("0.2.3+gabc1234.dirty");
  expect(versionFromDescription("0.2.3", "")).toBe("0.2.3");
  expect(versionFromDescription("0.2.3-rc.1", "v0.2.3-12-gabc1234")).toBe("0.2.3-rc.1+12.gabc1234");
});

test("local version falls back to package.json when Git is not installed", () => {
  const root = tmpDir();
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "7.8.9" }));
  const script = resolve(import.meta.dir, "..", "scripts", "build.ts");
  const result = Bun.spawnSync([process.execPath, "-e", `import { localBuildVersion } from ${JSON.stringify(script)}; console.log(localBuildVersion(${JSON.stringify(root)}));`], {
    // An empty PATH makes Bun use its default executable search path.
    env: { ...process.env, PATH: root },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("7.8.9");
});

test("local build embeds the package version in a standalone source archive", () => {
  const root = tmpDir();
  mkdirSync(join(root, "src", "update"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "7.8.9" }));
  for (const name of ["version.ts", "errors.ts"]) {
    copyFileSync(resolve(import.meta.dir, "..", "src", "update", name), join(root, "src", "update", name));
  }
  writeFileSync(join(root, "src", "cli.ts"), 'import { currentVersion } from "./update/version"; console.log(`pacer ${currentVersion()}`);');
  const script = resolve(import.meta.dir, "..", "scripts", "build.ts");
  // A source archive can live below a checkout. Stop ancestor discovery in this
  // child only, retaining PATH and the keychain stub used during local signing.
  const build = Bun.spawnSync([process.execPath, "-e", `
    import { buildLocal, localBuildVersion } from ${JSON.stringify(script)};
    import { writeFileSync } from "node:fs";
    const root = ${JSON.stringify(root)};
    if (localBuildVersion(root) !== "7.8.9") throw Error("archive did not use package version");
    writeFileSync(root + "/package.json", JSON.stringify({version: "7.8.9+12.gabc1234"}));
    await buildLocal(root);
  `], { env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) } });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  const result = Bun.spawnSync([join(root, "dist", "pacer"), "--version"], { cwd: tmpDir() });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim()).toBe("pacer 7.8.9+12.gabc1234");
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8"));
  expect(pkg.scripts.build).toBe("bun scripts/build.ts");
}, 60_000);
