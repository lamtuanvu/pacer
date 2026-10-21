#!/usr/bin/env bun
/** Local release-pipeline exercise only. These data-only packages are never native OTA candidates. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildDesktopFeed, DESKTOP_ARCHES, desktopAssetName, digest, publishDesktopRelease, type DesktopReleaseOptions } from "./desktop-feed";
import { localFixturePublisher } from "./desktop-publisher";

export async function fixtureFeedDryRun(root: string) {
  root = resolve(root);
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  // Still require a new output directory; never reuse an existing fixture.
  mkdirSync(root, { mode: 0o700 });
  const privateDir = join(root, "private"), release = join(root, "release"), version = "0.0.1", key = join(privateDir, "fixture.key");
  mkdirSync(privateDir, { mode: 0o700 }); mkdirSync(release, { mode: 0o700 });
  const cli = resolve(import.meta.dir, "../../desktop/node_modules/@tauri-apps/cli/tauri.js");
  async function signer(args: string[]) {
    const p = Bun.spawn([process.execPath, cli, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: privateDir, CI: "true" } });
    const [code, stdout] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if (code) throw Error("Fixture signer failed");
    return stdout.trim();
  }
  try {
    if (await signer(["--version"]) !== "tauri-cli 2.12.3") throw Error("Fixture requires pinned Tauri CLI 2.12.3");
    await signer(["signer", "generate", "--ci", "--password", "disposable-fixture", "--write-keys", key]);
    const publicKey = readFileSync(key + ".pub", "utf8").trim();
    writeFileSync(join(release, `desktop-release-${version}.json`), JSON.stringify({ schema: 1, version, notes: "Explicit local release fixture; not an installable app", pub_date: "2026-10-19T00:00:00Z" }));
    for (const arch of DESKTOP_ARCHES) {
      const metadata = { schema: 1, version, arch, bundleId: "dev.pacer.desktop", protocolMajors: [3], admissionProtocol: 1, nativeTransportAbi: 1, rollbackCompatible: true, fixture: true };
      const artifact = join(release, desktopAssetName(version, arch));
      // Build an explicit data fixture archive. No native manager or executable is represented as exercised.
      const archive = new Bun.Archive({ "pacer.app/Contents/Resources/pacer-release.json": JSON.stringify(metadata), "FIXTURE-ONLY.txt": "Data-only release fixture; never install" }, { compress: "gzip" });
      await Bun.write(artifact, await archive.blob());
      await signer(["signer", "sign", "--private-key-path", key, "--password", "disposable-fixture", "--app-version", version, artifact]);
    }
    const options: DesktopReleaseOptions = { mode: "fixture", publicKey, pins: { appleTeamId: "FIXTURE123" }, verifyArchive: async bytes => {
      const file = (await new Bun.Archive(gunzipSync(bytes)).files()).get("pacer.app/Contents/Resources/pacer-release.json");
      if (!file) throw Error("Missing fixture metadata");
      return JSON.parse(await file.text());
    } };
    const publisher = await localFixturePublisher(join(root, "local"), version);
    await publishDesktopRelease(release, version, publisher, options);
    const first = await publisher.readFeed();
    await publishDesktopRelease(release, version, publisher, options);
    if ((await publisher.readFeed()).head !== first.head) throw Error("Fixture retry changed feed");
    const feed = await buildDesktopFeed(release, version, options);
    writeFileSync(join(root, "stable.json"), feed);
    const report = { mode: "fixture", signatures: DESKTOP_ARCHES.length, immutableRetry: "PASS", cas: "PASS", feedSha256: digest(Buffer.from(feed)), production: "UNVERIFIED", native: "UNVERIFIED", detail: "Real Tauri signatures and local Git CAS; data-only archives, no Apple signing/notarization/native installation or remote publication" };
    writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally { rmSync(privateDir, { recursive: true, force: true }); }
}
if (import.meta.main) {
  try {
    const [flag, out] = process.argv.slice(2);
    if (flag !== "--fixture" || !out || process.argv.length !== 4) throw Error("usage: desktop-feed-fixture.ts --fixture <new-local-output-directory>");
    console.log(JSON.stringify(await fixtureFeedDryRun(out), null, 2));
  } catch (error) { console.error((error as Error).message); process.exit(1); }
}
