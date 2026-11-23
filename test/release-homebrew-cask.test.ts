import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(version = "2.3.4") {
  const dir = mkdtempSync(join(tmpdir(), "pacer-cask-"));
  dirs.push(dir);
  const arm = join(dir, `desktop-pacer-${version}-darwin-aarch64.dmg`);
  const intel = join(dir, `desktop-pacer-${version}-darwin-x86_64.dmg`);
  writeFileSync(arm, `arm-dmg-${version}`);
  writeFileSync(intel, `intel-dmg-${version}`);
  return { dir, arm, intel, out: join(dir, "Casks/pacer.rb"), version };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function generate(args: string[]) {
  return spawnSync(process.execPath, [resolve(import.meta.dir, "../scripts/release/homebrew-cask.ts"), ...args], {
    encoding: "utf8",
  });
}

test("generates a two-architecture cask with valid Ruby syntax", () => {
  const { arm, intel, out, version } = fixture();
  expect(generate(["--version", version, "--arm", arm, "--intel", intel, "--out", out]).status).toBe(0);
  const text = readFileSync(out, "utf8");
  expect(text).toContain('cask "pacer" do');
  expect(text).toContain(`version "${version}"`);
  expect(text).toContain(
    `https://github.com/lamtuanvu/pacer/releases/download/v#{version}/desktop-pacer-#{version}-darwin-aarch64.dmg`,
  );
  expect(text).toContain(
    `https://github.com/lamtuanvu/pacer/releases/download/v#{version}/desktop-pacer-#{version}-darwin-x86_64.dmg`,
  );
  const armBlock = /on_arm do\n([\s\S]*?)\n  end/.exec(text)?.[1] ?? "";
  const intelBlock = /on_intel do\n([\s\S]*?)\n  end/.exec(text)?.[1] ?? "";
  expect(armBlock).toContain(`sha256 "${sha256(arm)}"`);
  expect(intelBlock).toContain(`sha256 "${sha256(intel)}"`);
  expect(text).toContain("auto_updates true");
  expect(text).toContain('app "pacer.app"');
  expect(text).toContain("depends_on :macos");
  expect(text).toContain('if_path_exists "opt/pacer", base: :homebrew_prefix do'); expect(text).toContain('run "/bin/sh", args: ["-c", "echo \'The pacer CLI formula is installed. Run: brew uninstall pacer\' >&2; exit 1"]');
  expect(text).not.toContain("conflicts_with");
  expect(text).toContain('uninstall quit: "dev.pacer.desktop"');
  expect(text).toContain("zap trash:");
  expect(text).toContain("caveats");
  expect(text).not.toContain("binary");
  expect(text).not.toContain("launchctl");
  expect(text).not.toContain('.pacer"');
  expect(text).not.toContain("~/.pacer");
  if (Bun.which("ruby")) {
    const ruby = spawnSync("ruby", ["-c", out], { encoding: "utf8" });
    expect(ruby.status).toBe(0);
    expect(ruby.stdout).toContain("Syntax OK");
  }
});

test("refuses a missing architecture DMG before writing", () => {
  const { arm, out, version } = fixture();
  const missing = join(out, "..", "missing-intel.dmg");
  const result = generate(["--version", version, "--arm", arm, "--intel", missing, "--out", out]);
  expect(result.status).toBe(1);
  expect(existsSync(out)).toBe(false);
});

test("rejects a prerelease version", () => {
  const { arm, intel, out } = fixture("2.4.0-nightly.202611221200");
  const result = generate([
    "--version",
    "2.4.0-nightly.202611221200",
    "--arm",
    arm,
    "--intel",
    intel,
    "--out",
    out,
  ]);
  expect(result.status).toBe(1);
  expect(existsSync(out)).toBe(false);
});

test("--bundle-id overrides the quit target", () => {
  const { arm, intel, out, version } = fixture();
  expect(
    generate([
      "--version",
      version,
      "--arm",
      arm,
      "--intel",
      intel,
      "--out",
      out,
      "--bundle-id",
      "dev.pacer.desktop.fixture",
    ]).status,
  ).toBe(0);
  expect(readFileSync(out, "utf8")).toContain('uninstall quit: "dev.pacer.desktop.fixture"');
});
