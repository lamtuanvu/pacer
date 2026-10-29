import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crateContentHash, pluginCrateFolders, publishPluginCrates } from "../scripts/release/crates";

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

test("the independent protocol crates publish before the SDK that depends on all of them", () => {
  const root = join(import.meta.dir, "..");
  const manifest = (folder: string) => Bun.TOML.parse(readFileSync(join(root, "crates", folder, "Cargo.toml"), "utf8")) as { package: { name: string; version: string; publish?: boolean }; dependencies?: Record<string, unknown> };
  expect(pluginCrateFolders).toEqual(["plugin-decision-protocol", "plugin-agent-session-protocol", "plugin-protocol", "plugin-sdk"]);
  const names = pluginCrateFolders.map(folder => manifest(folder).package.name);
  for (const [index, folder] of pluginCrateFolders.entries()) {
    const { package: metadata, dependencies = {} } = manifest(folder);
    expect(metadata.publish).toBe(true);
    for (const dependency of Object.keys(dependencies).filter(name => names.includes(name))) expect(names.indexOf(dependency)).toBeLessThan(index);
  }
  const protocols = names.slice(0, -1);
  for (const folder of pluginCrateFolders.slice(0, -1)) expect(Object.keys(manifest(folder).dependencies ?? {}).filter(name => names.includes(name))).toEqual([]);
  expect(Object.keys(manifest("plugin-sdk").dependencies ?? {})).toEqual(expect.arrayContaining(protocols));
});

test("protocol area crate archives hash like the other plugin crates", async () => {
  for (const name of ["pacer-plugin-decision-protocol", "pacer-plugin-agent-session-protocol"]) {
    const bytes = await new Bun.Archive({ [`${name}-0.1.0/Cargo.toml`]: `[package]\nname="${name}"\n`, [`${name}-0.1.0/src/lib.rs`]: "source" }, { compress: "gzip" }).bytes();
    expect(await crateContentHash(bytes)).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("plugin crate publishing packages and publishes protocol before the SDK", async () => {
  const calls: string[] = [];
  await publishPluginCrates({
    crates: [{ name: "pacer-plugin-protocol", version: "0.1.0" }, { name: "pacer-plugin", version: "0.1.0" }],
    package: async crate => { calls.push(`package ${crate.name}`); return "a".repeat(64); },
    publishedChecksum: async () => null,
    dryRun: async crate => { calls.push(`dry-run ${crate.name}`); },
    publish: async crate => { calls.push(`publish ${crate.name}`); },
  });
  expect(calls).toEqual(["package pacer-plugin-protocol", "dry-run pacer-plugin-protocol", "publish pacer-plugin-protocol", "package pacer-plugin", "dry-run pacer-plugin", "publish pacer-plugin"]);
});

test("publishing retries accept identical archives and refuse immutable version conflicts", async () => {
  for (const same of [true, false]) {
    let uploads = 0;
    const run = () => publishPluginCrates({
      crates: [{ name: "pacer-plugin-protocol", version: "0.1.0" }],
      package: async () => "a".repeat(64),
      publishedChecksum: async () => (same ? "a" : "b").repeat(64),
      dryRun: async () => { throw Error("published crate must not need dry-run"); },
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
    dryRun: async () => {},
    publish: async () => { throw Error("registry refused"); },
  })).rejects.toThrow("registry refused");
  expect(packages).toEqual(["pacer-plugin-protocol"]);
});


test("SDK registry dry-run failure preserves published protocol and prevents SDK upload", async () => {
  const calls: string[] = [];
  await expect(publishPluginCrates({
    crates: [{ name: "pacer-plugin-protocol", version: "0.1.0" }, { name: "pacer-plugin", version: "0.1.0" }],
    package: async crate => { calls.push(`package ${crate.name}`); return "a".repeat(64); },
    publishedChecksum: async () => null,
    dryRun: async crate => { calls.push(`dry-run ${crate.name}`); if (crate.name === "pacer-plugin") throw Error("SDK registry dependency unavailable"); },
    publish: async crate => { calls.push(`publish ${crate.name}`); },
  })).rejects.toThrow("SDK registry dependency unavailable");
  expect(calls).toEqual(["package pacer-plugin-protocol", "dry-run pacer-plugin-protocol", "publish pacer-plugin-protocol", "package pacer-plugin", "dry-run pacer-plugin"]);
});

test("independent protocol dry-run refusal prevents all uploads and SDK packaging", async () => {
 const calls: string[]=[];
 await expect(publishPluginCrates({crates:[{name:"pacer-plugin-protocol",version:"0.1.0"},{name:"pacer-plugin",version:"0.1.0"}],package:async c=>{calls.push(`package ${c.name}`);return "a".repeat(64)},publishedChecksum:async()=>null,dryRun:async c=>{calls.push(`dry ${c.name}`);throw Error("protocol refusal")},publish:async c=>{calls.push(`publish ${c.name}`)}})).rejects.toThrow("protocol refusal");
 expect(calls).toEqual(["package pacer-plugin-protocol","dry pacer-plugin-protocol"]);
});
