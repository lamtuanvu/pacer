#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CASK_USAGE =
  "usage: bun run release:homebrew-cask --version <v> --arm <dmg> --intel <dmg> --out <file> [--bundle-id <id>]";

const DEFAULT_BUNDLE_ID = "dev.pacer.desktop";
const DESC = "Subscription budget routing for AI coding agents";

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function generateCask(opts: {
  version: string;
  arm: string;
  intel: string;
  out: string;
  bundleId?: string;
}): void {
  const { version, arm, intel, out } = opts;
  const bundleId = opts.bundleId ?? DEFAULT_BUNDLE_ID;
  if (version.includes("-")) {
    throw new Error(`prerelease version ${version} is not supported for the desktop cask`);
  }
  if (!existsSync(arm)) throw new Error(`arm DMG not found: ${arm}`);
  if (!existsSync(intel)) throw new Error(`intel DMG not found: ${intel}`);
  const armSha = sha256File(arm);
  const intelSha = sha256File(intel);
  const armUrl =
    `https://github.com/lamtuanvu/pacer/releases/download/v${version}/desktop-pacer-${version}-darwin-aarch64.dmg`;
  const intelUrl =
    `https://github.com/lamtuanvu/pacer/releases/download/v${version}/desktop-pacer-${version}-darwin-x86_64.dmg`;
  const cask = `cask "pacer" do
  version "${version}"

  on_arm do
    url "${armUrl}"
    sha256 "${armSha}"
  end
  on_intel do
    url "${intelUrl}"
    sha256 "${intelSha}"
  end

  name "pacer"
  desc "${DESC}"
  homepage "https://github.com/lamtuanvu/pacer"

  auto_updates true
  depends_on macos: ">= :big_sur"
  conflicts_with formula: "pacer"

  app "pacer.app"

  uninstall quit: "${bundleId}"

  zap trash: [
    "~/Library/Caches/${bundleId}",
    "~/Library/Preferences/${bundleId}.plist",
    "~/Library/Saved Application State/${bundleId}.savedState",
    "~/Library/WebKit/${bundleId}",
  ]

  caveats <<~EOS
    pacer updates itself; \`brew upgrade\` leaves it alone unless you pass --greedy.
    While builds are self-signed, approve the first launch once in
    System Settings › Privacy & Security › Open Anyway (again after a brew reinstall).
    To remove the service, the pacer command and agent hooks, run \`pacer uninstall --all\`.
  EOS
end
`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, cask);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const values: Record<string, string> = {};
  const flags = ["--version", "--arm", "--intel", "--out", "--bundle-id"];
  for (let i = 0; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || values[args[i]]) {
      console.error(CASK_USAGE);
      process.exit(2);
    }
    values[args[i]] = args[i + 1];
  }
  if (!values["--version"] || !values["--arm"] || !values["--intel"] || !values["--out"]) {
    console.error(CASK_USAGE);
    process.exit(2);
  }
  try {
    generateCask({
      version: values["--version"],
      arm: resolve(values["--arm"]),
      intel: resolve(values["--intel"]),
      out: resolve(values["--out"]),
      bundleId: values["--bundle-id"],
    });
  } catch (e) {
    console.error(`release:homebrew-cask: ${(e as Error).message}`);
    process.exit(1);
  }
}
