#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assetFile, parseManifest, TARGETS, type ReleaseOs } from "../../src/update/manifest";

export const HOMEBREW_USAGE = "usage: bun run release:homebrew --manifest <path> --out <file>";
export function generateHomebrew(manifestPath: string, out: string): void {
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const paired = manifest.assets.some(asset => asset.companions?.length);
  for (const p of TARGETS) {
    if (!manifest.assets.some((a) => a.file === assetFile(p))) throw new Error(`manifest is missing ${assetFile(p)}; Homebrew requires all four release platforms`);
    if (paired && !manifest.assets.find(asset => asset.file === assetFile(p))?.companions?.length) throw new Error(`manifest is missing pacer-core for ${assetFile(p)}`);
  }
  function platform(os: ReleaseOs): string {
    const blocks = (["arm64", "x64"] as const).map((arch) => {
      const a = manifest.assets.find((x) => x.os === os && x.arch === arch)!;
      const core = a.companions?.[0];
      const resource = core ? `\n      resource "pacer-core" do\n        url "https://github.com/lamtuanvu/pacer/releases/download/v${manifest.version}/${core.file}"\n        sha256 "${core.sha256}"\n      end` : "";
      return `    on_${arch === "arm64" ? "arm" : "intel"} do\n      url "https://github.com/lamtuanvu/pacer/releases/download/v${manifest.version}/${a.file}"\n      sha256 "${a.sha256}"${resource}\n    end`;
    });
    return `  on_${os === "darwin" ? "macos" : "linux"} do\n${blocks.join("\n\n")}\n  end`;
  }
  const formula = `class Pacer < Formula
  desc "Subscription budget routing for AI coding agents"
  homepage "https://github.com/lamtuanvu/pacer"
  version "${manifest.version}"
  license "Apache-2.0"

${platform("darwin")}

${platform("linux")}

  def install
${paired ? `    libexec.install Dir["pacer-*"].first => "pacer"
    resource("pacer-core").stage do
      libexec.install Dir["pacer-core-*"].first => "pacer-core"
    end
    bin.install_symlink libexec/"pacer"` : `    bin.install Dir["pacer-*"].first => "pacer"`}
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pacer --version")
  end
end
`;
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, formula);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2); const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--manifest", "--out"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || values[args[i]]) {
      console.error(HOMEBREW_USAGE); process.exit(2);
    }
    values[args[i]] = args[i + 1];
  }
  if (!values["--manifest"] || !values["--out"]) { console.error(HOMEBREW_USAGE); process.exit(2); }
  try { generateHomebrew(resolve(values["--manifest"]), resolve(values["--out"])); }
  catch (e) { console.error(`release:homebrew: ${(e as Error).message}`); process.exit(1); }
}
