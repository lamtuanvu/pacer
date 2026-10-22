import { expect, test } from "bun:test";
import { crateContentHash, publishPluginCrates } from "../scripts/release/crates";

test("independent crate versions ignore generated VCS and lock metadata but detect source changes", async () => {
  const archive = async (sha: string, source: string) => new Bun.Archive({
    "pacer-plugin-0.1.0/.cargo_vcs_info.json": JSON.stringify({ git: { sha1: sha } }),
    "pacer-plugin-0.1.0/Cargo.lock": sha,
    "pacer-plugin-0.1.0/Cargo.toml": '[package]\nname="pacer-plugin"\nversion="0.1.0"\n',
    "pacer-plugin-0.1.0/src/lib.rs": source,
  }, { compress: "gzip" }).bytes();
  const first = await crateContentHash(await archive("a", "source"));
  expect(await crateContentHash(await archive("b", "source"))).toBe(first);
  expect(await crateContentHash(await archive("b", "changed"))).not.toBe(first);
});

test("plugin crate publishing packages and publishes protocol before the SDK", async () => {
  const calls: string[] = [];
  await publishPluginCrates({
    crates: [{ name: "pacer-plugin-protocol", version: "0.1.0" }, { name: "pacer-plugin", version: "0.1.0" }],
    package: async crate => { calls.push(`package ${crate.name}`); return "a".repeat(64); },
    publishedChecksum: async () => null,
    publish: async crate => { calls.push(`publish ${crate.name}`); },
  });
  expect(calls).toEqual(["package pacer-plugin-protocol", "publish pacer-plugin-protocol", "package pacer-plugin", "publish pacer-plugin"]);
});

test("publishing retries accept identical archives and refuse immutable version conflicts", async () => {
  for (const same of [true, false]) {
    let uploads = 0;
    const run = () => publishPluginCrates({
      crates: [{ name: "pacer-plugin-protocol", version: "0.1.0" }],
      package: async () => "a".repeat(64),
      publishedChecksum: async () => (same ? "a" : "b").repeat(64),
      publish: async () => { uploads++; },
    });
    if (same) await run();
    else await expect(run()).rejects.toThrow("different bytes");
    expect(uploads).toBe(0);
  }
});

test("a failed protocol publication prevents SDK packaging and publication", async () => {
  const packages: string[] = [];
  await expect(publishPluginCrates({
    crates: [{ name: "pacer-plugin-protocol", version: "0.1.0" }, { name: "pacer-plugin", version: "0.1.0" }],
    package: async c => { packages.push(c.name); return "a".repeat(64); },
    publishedChecksum: async () => null,
    publish: async () => { throw Error("registry refused"); },
  })).rejects.toThrow("registry refused");
  expect(packages).toEqual(["pacer-plugin-protocol"]);
});
