#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { sha256Hex } from "../../src/update/manifest";

interface Crate { name: string; version: string }
interface Publishing {
  crates: Crate[];
  package: (crate: Crate) => Promise<string>;
  publishedChecksum: (crate: Crate) => Promise<string | null>;
  publish: (crate: Crate) => Promise<void>;
}

/** Application-only commits change Cargo's generated provenance and lockfile.
 * Compare the actual published library inputs so its version stays independent. */
export async function crateContentHash(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > 10 * 1024 * 1024) throw Error("Plugin crate archive exceeds 10 MB");
  const files = await new Bun.Archive(gunzipSync(bytes, { maxOutputLength: 20 * 1024 * 1024 })).files();
  if (!files.size || files.size > 2048) throw Error("Invalid plugin crate archive file count");
  const entries: [string, string][] = [];
  let size = 0;
  let root: string | undefined;
  for (const [path, file] of files) {
    const match = /^(pacer-plugin(?:-protocol)?-\d+\.\d+\.\d+)\/(.+)$/.exec(path);
    if (!match || match[2].split("/").some(part => !part || part === "." || part === "..") || path.includes("\\")) throw Error("Invalid plugin crate archive path");
    if (root !== undefined && root !== match[1]) throw Error("Plugin crate has multiple archive roots");
    root = match[1];
    if ([".cargo_vcs_info.json", "Cargo.lock"].includes(match[2])) continue;
    size += file.size;
    if (size > 20 * 1024 * 1024) throw Error("Plugin crate contents exceed 20 MB");
    entries.push([match[2], sha256Hex(new Uint8Array(await file.arrayBuffer()))]);
  }
  if (!entries.some(([path]) => path === "Cargo.toml") || !entries.some(([path]) => path === "src/lib.rs")) throw Error("Plugin crate is missing library metadata or source");
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sha256Hex(Buffer.from(JSON.stringify(entries)));
}

/** Sequential publication is required for the SDK's registry dependency. */
export async function publishPluginCrates(options: Publishing): Promise<void> {
  for (const crate of options.crates) {
    const checksum = await options.package(crate);
    const published = await options.publishedChecksum(crate);
    if (published !== null) {
      if (published !== checksum) throw Error(`${crate.name} ${crate.version} is already published with different bytes; bump its version`);
      continue;
    }
    await options.publish(crate);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const publish = args.length === 1 && args[0] === "--publish";
  if (args.length && !publish) throw Error("usage: bun scripts/release/crates.ts [--publish]");
  if (publish && !process.env.CARGO_REGISTRY_TOKEN) throw Error("CARGO_REGISTRY_TOKEN is required to publish plugin crates");
  const root = resolve(import.meta.dir, "../..");
  const crates = ["plugin-protocol", "plugin-sdk"].map(folder => {
    const { package: metadata } = Bun.TOML.parse(readFileSync(join(root, "crates", folder, "Cargo.toml"), "utf8")) as { package: { name: string; version: string } };
    if (!/^pacer-plugin(-protocol)?$/.test(metadata.name) || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw Error("Invalid plugin crate release metadata");
    return { name: metadata.name, version: metadata.version };
  });
  const run = async (argv: string[]) => {
    console.log(argv.join(" "));
    const child = Bun.spawn(argv, { cwd: root, env: { ...process.env, CARGO_TARGET_DIR: join(root, "target") }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 600000 });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw Error(`${argv[0]} ${argv[1]} failed (${code}):\n${stderr.slice(-16000)}\n${stdout.slice(-16000)}`);
  };
  await publishPluginCrates({
    crates,
    package: async crate => {
      await run(["cargo", "package", "--locked", "-p", crate.name]);
      return crateContentHash(readFileSync(join(root, "target/package", `${crate.name}-${crate.version}.crate`)));
    },
    publishedChecksum: async crate => {
      const response = await fetch(`https://crates.io/api/v1/crates/${crate.name}/${crate.version}`, { headers: { "User-Agent": "pacer-release (github.com/lamtuanvu/pacer)" }, signal: AbortSignal.timeout(30000) });
      if (response.status === 404) return null;
      if (!response.ok) throw Error(`Cannot inspect registry version: HTTP ${response.status}`);
      const result = await response.json() as { version?: { checksum?: string } };
      const checksum = result.version?.checksum;
      if (!checksum || !/^[0-9a-f]{64}$/.test(checksum)) throw Error("Registry response has no valid archive checksum");
      const archive = await fetch(`https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate`, { redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!archive.ok || !archive.body) throw Error("Cannot download published crate for comparison");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = archive.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 10 * 1024 * 1024) throw Error("Published crate exceeds 10 MB");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = Buffer.concat(chunks);
      if (sha256Hex(bytes) !== checksum) throw Error("Published crate archive checksum mismatch");
      return crateContentHash(bytes);
    },
    publish: async crate => {
      await run(["cargo", "publish", "--locked", "-p", crate.name, ...(publish ? [] : ["--dry-run"])]);
    },
  });
}
