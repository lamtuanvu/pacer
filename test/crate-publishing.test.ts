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

test("0.2 release graph packages independent areas before the SDK", async () => {
  const { PLUGIN_CRATE_FOLDERS } = await import("../scripts/release/crates");
  expect(PLUGIN_CRATE_FOLDERS).toEqual(["plugin-protocol", "plugin-agent-protocol", "plugin-dispatch-protocol", "plugin-hosts-protocol", "plugin-sdk"]);
  const { readFileSync } = await import("node:fs");
  const metadata = PLUGIN_CRATE_FOLDERS.map(folder => Bun.TOML.parse(readFileSync(new URL(`../crates/${folder}/Cargo.toml`, import.meta.url), "utf8")) as { package: { name: string; version: string; publish: boolean }; dependencies: Record<string, unknown> });
  for (const item of metadata) expect(item.package).toMatchObject({ version: "0.2.0", publish: true });
  for (const item of metadata.slice(0, 4)) expect(Object.keys(item.dependencies).filter(name => name.startsWith("pacer-plugin"))).toEqual([]);
  const sdk = metadata[4]!;
  for (const name of ["pacer-plugin-protocol", "pacer-plugin-agent-protocol", "pacer-plugin-dispatch-protocol", "pacer-plugin-hosts-protocol"]) expect(sdk.dependencies[name]).toMatchObject({ version: "0.2.0" });
  expect(sdk.dependencies["pacer-plugin-policy-protocol"]).toBeUndefined();
  const calls: string[] = [];
  await expect(publishPluginCrates({
    crates: metadata.map(item => ({ name: item.package.name, version: item.package.version })),
    package: async item => { calls.push(item.name); return "a".repeat(64); },
    publishedChecksum: async () => null,
    dryRun: async item => { if (item.name === "pacer-plugin-dispatch-protocol") throw Error("dispatch refused"); },
    publish: async () => {},
  })).rejects.toThrow("dispatch refused");
  expect(calls).toEqual(["pacer-plugin-protocol", "pacer-plugin-agent-protocol", "pacer-plugin-dispatch-protocol"]);
});

test("new publishable area archives use the same bounded canonical content checks", async () => {
  for (const name of ["pacer-plugin-agent-protocol", "pacer-plugin-dispatch-protocol", "pacer-plugin-hosts-protocol"]) {
    const bytes = await new Bun.Archive({
      [`${name}-0.2.0/Cargo.toml`]: `[package]\nname="${name}"\nversion="0.2.0"\n`,
      [`${name}-0.2.0/src/lib.rs`]: "pub struct Distinct;",
    }, { compress: "gzip" }).bytes();
    expect(await crateContentHash(bytes)).toMatch(/^[0-9a-f]{64}$/);
  }
  const privateArea = await new Bun.Archive({ "pacer-plugin-policy-protocol-0.0.0/Cargo.toml": "private", "pacer-plugin-policy-protocol-0.0.0/src/lib.rs": "private" }, { compress: "gzip" }).bytes();
  await expect(crateContentHash(privateArea)).rejects.toThrow("Invalid plugin crate archive path");
});
