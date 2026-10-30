import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fakeCtx, tmpDir } from "./helpers";
import { extractArchive, inspectArchive, verifyArchive, verifyPublishedArchive, MAX_FILE_BYTES } from "../src/plugins/archive";
import { createPublisherTrust } from "../src/plugins/publishers";
import { packPlugin, publishAbsent, readBoundedPluginFile, readPluginInput } from "../scripts/plugin-pack";

type Entry = { path: string; type?: string; data?: Uint8Array; declaredSize?: number };
const manifest = JSON.stringify({ id: "fx-archive", version: "1.0.0", publisher: "Fixture", host: "*", entry: "main.js", contributes: {}, capabilities: [] });
const validEntries: Entry[] = [
  { path: "fx-archive/", type: "5" },
  { path: "fx-archive/pacer-plugin.json", data: Buffer.from(manifest) },
  { path: "fx-archive/main.js", data: Buffer.from("#!/usr/bin/env bun\n") },
];

function octal(header: Buffer, offset: number, width: number, value: number): void {
  header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function tar(entries: Entry[], trailer?: Uint8Array): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? []);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    octal(header, 100, 8, entry.type === "5" ? 0o700 : 0o600);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, entry.declaredSize ?? data.length);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    octal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  if (trailer) blocks.push(Buffer.from(trailer));
  return Buffer.concat(blocks);
}

const archive = (entries: Entry[], trailer?: Uint8Array) => gzipSync(tar(entries, trailer));

test("one-root signed archive extracts exactly its inspected regular files", async () => {
  const bytes = archive(validEntries);
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, bytes)).toString("base64");
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
  const inspected = inspectArchive(bytes);
  expect(inspected.manifest.id).toBe("fx-archive");
  expect(inspected.entries.map(entry => entry.path)).toEqual(["fx-archive/pacer-plugin.json", "fx-archive/main.js"]);
  bytes.fill(0); // A caller cannot alter the retained bytes after inspection.
  const verified = await verifyArchive(inspected, signature, publicKey);
  const out = join(tmpDir(), "stage");
  mkdirSync(out, { mode: 0o700 });
  extractArchive(verified, out);
  expect(readFileSync(join(out, "main.js"), "utf8")).toBe("#!/usr/bin/env bun\n");
  expect(JSON.parse(readFileSync(join(out, "pacer-plugin.json"), "utf8")).id).toBe("fx-archive");
  expect(lstatSync(join(out, "main.js")).mode & 0o777).toBe(0o700);
  expect(existsSync(join(out, "fx-archive"))).toBe(false);
});

test("signature verification refuses an unrelated publisher key and malformed signature", async () => {
  const bytes = archive(validEntries);
  const a = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const b = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", a.privateKey, bytes)).toString("base64");
  const wrongKey = Buffer.from(await crypto.subtle.exportKey("raw", b.publicKey)).toString("base64");
  await expect(verifyArchive(inspectArchive(bytes), signature, wrongKey)).rejects.toThrow();
  await expect(verifyArchive(inspectArchive(bytes), "not base64!", wrongKey)).rejects.toThrow();
});

async function signed(bytes: Uint8Array) {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, Uint8Array.from(bytes))).toString("base64");
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
  return { signature, publicKey };
}

test("publisher-bound verification fails closed for an unknown publisher", async () => {
  const bytes = archive(validEntries), { signature, publicKey } = await signed(bytes);
  const ctx = fakeCtx({ pacerHome: join(realpathSync(tmpDir()), ".pacer") });
  await expect(verifyPublishedArchive(ctx, inspectArchive(bytes), signature, createPublisherTrust({}))).rejects.toThrow("unknown publisher");
  await expect(verifyPublishedArchive(ctx, inspectArchive(bytes), signature, createPublisherTrust({ Other: publicKey }))).rejects.toThrow("unknown publisher");
  const verified = await verifyPublishedArchive(ctx, inspectArchive(bytes), signature, createPublisherTrust({ Fixture: publicKey }));
  expect(verified.verified).toBe(true);
});

test("publisher-bound verification refuses a signature from a key other than the trusted one", async () => {
  const bytes = archive(validEntries), { signature } = await signed(bytes), other = await signed(bytes);
  const ctx = fakeCtx({ pacerHome: join(realpathSync(tmpDir()), ".pacer") });
  await expect(verifyPublishedArchive(ctx, inspectArchive(bytes), signature, createPublisherTrust({ Fixture: other.publicKey }))).rejects.toThrow("signature invalid");
});

test("a tampered archive fails verification against the original signature", async () => {
  const bytes = archive(validEntries), { signature, publicKey } = await signed(bytes);
  const tampered = archive([validEntries[0]!, validEntries[1]!, { path: "fx-archive/main.js", data: Buffer.from("#!/usr/bin/env bun\nevil()\n") }]);
  await expect(verifyArchive(inspectArchive(tampered), signature, publicKey)).rejects.toThrow("signature invalid");
  const flipped = Buffer.from(bytes); flipped[flipped.length - 5] ^= 1; // gzip CRC/size trailer
  expect(() => inspectArchive(flipped)).toThrow("gzip");
  const forged = Buffer.from(signature, "base64"); forged[0] ^= 1;
  await expect(verifyArchive(inspectArchive(bytes), forged.toString("base64"), publicKey)).rejects.toThrow("signature invalid");
});

test("unverified inspections and symlinked destinations are refused at extraction", async () => {
  const bytes = archive(validEntries), { signature, publicKey } = await signed(bytes);
  const inspected = inspectArchive(bytes);
  expect(() => extractArchive(inspected as never, tmpDir())).toThrow("provenance");
  await expect(verifyArchive({ ...inspected }, signature, publicKey)).rejects.toThrow("provenance");
  const verified = await verifyArchive(inspected, signature, publicKey);
  const root = tmpDir(), real = join(root, "real"), link = join(root, "link");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, link);
  expect(() => extractArchive(verified, link)).toThrow("destination");
  expect(readdirSync(real)).toEqual([]);
});

test("archive inventory refuses ambiguous tar names, types and headers before extraction", () => {
  const cases: [string, Entry[]][] = [
    ["duplicate", [...validEntries, validEntries[2]!]],
    ["case-colliding", [...validEntries, { path: "fx-archive/MAIN.js", data: Buffer.from("x") }]],
    ["traversal", [...validEntries, { path: "fx-archive/../escape", data: Buffer.from("x") }]],
    ["absolute", [...validEntries, { path: "/outside", data: Buffer.from("x") }]],
    ["second root", [...validEntries, { path: "other/file", data: Buffer.from("x") }]],
    ["absolute", [...validEntries, { path: "/fx-archive/main2.js", data: Buffer.from("x") }]],
    ["traversal", [...validEntries, { path: "fx-archive/./main2.js", data: Buffer.from("x") }]],
    ["link", [...validEntries, { path: "fx-archive/link", type: "2" }]],
    ["hardlink", [...validEntries, { path: "fx-archive/hard", type: "1" }]],
    ["device", [...validEntries, { path: "fx-archive/device", type: "3" }]],
    ["pax", [...validEntries, { path: "fx-archive/pax", type: "x" }]],
    ["gnu long name", [...validEntries, { path: "fx-archive/long", type: "L" }]],
    ["sparse", [...validEntries, { path: "fx-archive/sparse", type: "S" }]],
    ["oversized file", [...validEntries, { path: "fx-archive/huge", declaredSize: 200 * 1024 * 1024 + 1 }]],
    ["missing manifest", [validEntries[0]!, validEntries[2]!]],
    ["duplicate manifest", [...validEntries, validEntries[1]!]],
  ];
  for (const [reason, entries] of cases) expect(() => inspectArchive(archive(entries))).toThrow(reason);
  expect(() => inspectArchive(archive(validEntries, Buffer.from("nonzero")))).toThrow("trailing");
  const badChecksum = tar(validEntries); badChecksum[0] ^= 1;
  expect(() => inspectArchive(gzipSync(badChecksum))).toThrow("checksum");
  const unsafeMode = tar(validEntries);
  octal(unsafeMode, 100, 8, 0o777);
  unsafeMode.fill(32, 148, 156);
  octal(unsafeMode, 148, 8, unsafeMode.subarray(0, 512).reduce((sum, byte) => sum + byte, 0));
  expect(() => inspectArchive(gzipSync(unsafeMode))).toThrow("mode");
  for (const entries of [
    [...validEntries, { path: "fx-archive/a", data: Buffer.from("x") }, { path: "fx-archive/a/b", data: Buffer.from("x") }],
    [...validEntries, { path: "fx-archive/a/b", data: Buffer.from("x") }, { path: "fx-archive/a", data: Buffer.from("x") }],
  ]) expect(() => inspectArchive(archive(entries))).toThrow("file/descendant");
});

test("near-limit expanded files plus padded small entries fit the tar expansion bound", () => {
  const smallCount = 5_400;
  const entries: Entry[] = [
    validEntries[0]!, validEntries[1]!, validEntries[2]!,
    { path: "fx-archive/big", data: Buffer.alloc(MAX_FILE_BYTES - Buffer.byteLength(manifest) - validEntries[2]!.data!.length - smallCount) },
    ...Array.from({ length: smallCount }, (_, n) => ({ path: `fx-archive/f${n}`, data: Buffer.from("x") })),
  ];
  expect(inspectArchive(archive(entries)).entries.length).toBe(smallCount + 3);
});

test("bounded packer read refuses a file grown after its checked size", () => {
  const path = join(tmpDir(), "growing");
  writeFileSync(path, "before");
  const fd = openSync(path, "r");
  try {
    expect(() => readBoundedPluginFile(fd, 1024, () => appendFileSync(path, "after"))).toThrow("changed");
  } finally { closeSync(fd); }
});

test("private-key sized bounded read rejects growth after its 16 KiB check", () => {
  const path = join(tmpDir(), "key.pem");
  writeFileSync(path, "short", { mode: 0o600 });
  const fd = openSync(path, "r");
  try {
    expect(() => readBoundedPluginFile(fd, 16 * 1024, () => appendFileSync(path, Buffer.alloc(32 * 1024)))).toThrow("changed");
  } finally { closeSync(fd); }
});

test("packer refuses a regular input swapped after pathname inspection", () => {
  const root = tmpDir(), path = join(root, "source"), replacement = join(root, "replacement");
  writeFileSync(path, "original");
  writeFileSync(replacement, "different");
  const inspected = lstatSync(path);
  expect(() => readPluginInput(path, inspected, 1024, () => renameSync(replacement, path))).toThrow("identity");
});

test("no-replace publication cleans its temp on a pre-link failure or collision", () => {
  const root = tmpDir(), output = join(root, "artifact.tgz");
  expect(() => publishAbsent(output, Buffer.from("new"), () => { throw new Error("injected"); })).toThrow("injected");
  expect(existsSync(output)).toBe(false);
  expect(readdirSync(root).filter(name => name.endsWith(".tmp"))).toEqual([]);
  writeFileSync(output, "original");
  expect(() => publishAbsent(output, Buffer.from("new"))).toThrow();
  expect(readFileSync(output, "utf8")).toBe("original");
  expect(readdirSync(root).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("archive caps compressed bytes, entry count, and truncated streams", () => {
  expect(() => inspectArchive(Buffer.alloc(50 * 1024 * 1024 + 1))).toThrow("50 MB");
  const many = [validEntries[0]!, validEntries[1]!, ...Array.from({ length: 10_000 }, (_, n) => ({ path: `fx-archive/f${n}`, data: Buffer.alloc(0) }))];
  expect(() => inspectArchive(archive(many))).toThrow("entry count");
  const truncated = tar(validEntries).subarray(0, 700);
  expect(() => inspectArchive(gzipSync(truncated))).toThrow();
});

test("manifest entry is confined to an accepted regular file, while a surface-only plugin may omit it", () => {
  const surfaceManifest = JSON.stringify({ id: "fx-archive", version: "1.0.0", publisher: "Fixture", host: "*", contributes: {}, capabilities: [] });
  expect(inspectArchive(archive([
    validEntries[0]!, { path: "fx-archive/pacer-plugin.json", data: Buffer.from(surfaceManifest) },
  ])).manifest.entry).toBeUndefined();
  const escaping = manifest.replace('"entry":"main.js"', '"entry":"../escape"');
  expect(() => inspectArchive(archive([
    validEntries[0]!, { path: "fx-archive/pacer-plugin.json", data: Buffer.from(escaping) }, validEntries[2]!,
  ]))).toThrow("traversal");
});

test("packer uses a private key file, creates a signed archive without replacement, and never follows input links", async () => {
  const root = tmpDir(), dir = join(root, "fx-archive"), keyPath = join(root, "key.pem"), output = join(root, "fx-archive-1.0.0.tgz");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "pacer-plugin.json"), manifest);
  writeFileSync(join(dir, "main.js"), "#!/usr/bin/env bun\n");
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const key = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  writeFileSync(keyPath, `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64");
  await packPlugin(dir, keyPath, output);
  expect(existsSync(`${output}.sig`)).toBe(true);
  await verifyArchive(inspectArchive(readFileSync(output)), readFileSync(`${output}.sig`, "utf8").trim(), publicKey);
  await expect(packPlugin(dir, keyPath, output)).rejects.toThrow();
  expect(readFileSync(output).length).toBeGreaterThan(0);
  expect(readdirSync(root).filter(name => name.endsWith(".tmp"))).toEqual([]);
  const blocked = join(root, "blocked.tgz");
  writeFileSync(`${blocked}.sig`, "existing-signature");
  await expect(packPlugin(dir, keyPath, blocked)).rejects.toThrow();
  expect(readFileSync(`${blocked}.sig`, "utf8")).toBe("existing-signature");
  expect(existsSync(blocked)).toBe(false);
  expect(readdirSync(root).filter(name => name.endsWith(".tmp"))).toEqual([]);
  chmodSync(keyPath, 0o644);
  await expect(packPlugin(dir, keyPath, join(root, "other.tgz"))).rejects.toThrow("0600");
  chmodSync(keyPath, 0o600);
  symlinkSync("main.js", join(dir, "link"));
  await expect(packPlugin(dir, keyPath, join(root, "linked.tgz"))).rejects.toThrow("symlink");
});
