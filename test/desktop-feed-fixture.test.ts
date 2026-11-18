import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { DESKTOP_ARCHES } from "../scripts/release/desktop-feed";
import { fixtureFeedDryRun } from "../scripts/release/desktop-feed-fixture";
// The pinned Tauri signer lives in desktop/node_modules, which the PR test job does not install;
// the release workflow's dry-run desktop-fixture job installs it and runs this same exercise.
const signer = existsSync(join(import.meta.dir, "../desktop/node_modules/@tauri-apps/cli/tauri.js"));
test.skipIf(!signer)("explicit fixture driver uses real pinned signer and local immutable assets without leaving private keys", async () => {
  const root = join(tmpDir(), "dist", "fixture");
  const report = await fixtureFeedDryRun(root);
  expect(report.mode).toBe("fixture");
  expect(report.production).toBe("UNVERIFIED");
  expect(report.native).toBe("UNVERIFIED");
  expect(report.signatures).toBe(DESKTOP_ARCHES.length * 2); // stable and nightly
  expect(existsSync(join(root, "private"))).toBe(false);
  const feed = JSON.parse(readFileSync(join(root, "stable.json"), "utf8"));
  expect(Object.keys(feed.platforms).sort()).toEqual(DESKTOP_ARCHES.map(arch => `darwin-${arch}`).sort());
  for (const platform of Object.values(feed.platforms) as { bundleId: string }[]) expect(platform.bundleId).toBe("dev.pacer.desktop.fixture");
  expect(existsSync(join(root, "local/feed.git"))).toBe(true);
  expect(report.nightly).toBe("PASS");
  const nightly = JSON.parse(readFileSync(join(root, "nightly.json"), "utf8"));
  expect(nightly.version).toBe("0.1.0-nightly.202611170000");
  expect(Object.keys(nightly.platforms).sort()).toEqual(DESKTOP_ARCHES.map(arch => `darwin-${arch}`).sort());
  const show = (name: string) => Bun.spawnSync(["git", "--git-dir", join(root, "local/feed.git"), "show", `desktop-updates:${name}`], { stdout: "pipe" }).stdout.toString();
  expect(show("nightly.json")).toBe(readFileSync(join(root, "nightly.json"), "utf8"));
  expect(show("stable.json")).toBe(readFileSync(join(root, "stable.json"), "utf8"));
  await expect(fixtureFeedDryRun(root)).rejects.toThrow();
}, 60000);
