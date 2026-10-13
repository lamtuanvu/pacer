#!/usr/bin/env bun
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assetFile, parseManifest, sha256Hex, TARGETS } from "../../src/update/manifest";

export const NPM_USAGE = "usage: bun run release:npm --release-dir <dir> --out <dir>";
export function generateNpm(releaseDir: string, out: string, root = resolve(import.meta.dir, "../..")): void {
  const manifest = parseManifest(JSON.parse(readFileSync(join(releaseDir, "manifest.json"), "utf8")));
  const binaries = TARGETS.map((p) => {
    const file = assetFile(p);
    const asset = manifest.assets.find((a) => a.file === file);
    if (!asset) throw new Error(`manifest is missing ${file}; npm requires all four release platforms`);
    const bytes = readFileSync(join(releaseDir, file));
    if (sha256Hex(bytes) !== asset.sha256) throw new Error(`checksum mismatch for ${file}`);
    if (bytes.length !== asset.size) throw new Error(`size mismatch for ${file}`);
    return { ...p, file, bytes };
  });
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const optionalDependencies: Record<string, string> = {};
  const order: string[] = [];
  function writePackage(dir: string, pkg: object, readme?: string) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    for (const file of ["LICENSE", "NOTICE"]) copyFileSync(join(root, file), join(dir, file));
    if (readme) writeFileSync(join(dir, "README.md"), readme);
    else copyFileSync(join(root, "README.md"), join(dir, "README.md"));
  }
  for (const b of binaries) {
    const name = `@lamtuanvu/${b.file}`; const dir = join(out, b.file);
    optionalDependencies[name] = manifest.version; order.push(b.file);
    writePackage(dir, {
      name, version: manifest.version, description: `Platform binary for @lamtuanvu/pacer (${b.os}-${b.arch})`, license: "Apache-2.0",
      repository: { type: "git", url: "git+https://github.com/lamtuanvu/pacer.git", directory: "npm" },
      os: [b.os], cpu: [b.arch], files: ["bin/pacer"], publishConfig: { access: "public" },
    }, `# ${name}\n\nThis is an internal platform package of @lamtuanvu/pacer. Install @lamtuanvu/pacer to use the CLI.\n`);
    const bin = join(dir, "bin/pacer"); writeFileSync(bin, b.bytes); chmodSync(bin, 0o755);
  }
  const launcher = join(out, "pacer");
  writePackage(launcher, {
    name: "@lamtuanvu/pacer", version: manifest.version, description: source.description, license: "Apache-2.0", type: "commonjs",
    bin: { pacer: "bin/pacer.js" }, files: ["bin/pacer.js"], optionalDependencies, engines: { node: ">=18" },
    publishConfig: { access: "public" }, keywords: source.keywords, homepage: source.homepage, bugs: source.bugs, repository: source.repository,
  });
  copyFileSync(join(root, "npm/launcher/bin/pacer.js"), join(launcher, "bin/pacer.js")); chmodSync(join(launcher, "bin/pacer.js"), 0o755);
  order.push("pacer"); writeFileSync(join(out, "publish-order.txt"), `${order.join("\n")}\n`);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2); const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--release-dir", "--out"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || values[args[i]]) {
      console.error(NPM_USAGE); process.exit(2);
    }
    values[args[i]] = args[i + 1];
  }
  if (!values["--release-dir"] || !values["--out"]) { console.error(NPM_USAGE); process.exit(2); }
  try { generateNpm(resolve(values["--release-dir"]), resolve(values["--out"])); }
  catch (e) { console.error(`release:npm: ${(e as Error).message}`); process.exit(1); }
}
