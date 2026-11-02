// Regenerate the PR #618 regression goldens against the TypeScript reference.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { strict as assert } from "node:assert";
import { StrategyDoc } from "../src/config/edit";
import { inspectArchive } from "../src/plugins/archive";

const archivePath = "test/fixtures/plugin-archive-parity.json";
const archives = JSON.parse(readFileSync(archivePath, "utf8"));
function checksum(header: Buffer) {
  header.fill(32, 148, 156);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(7, "0") + "\0", 148, "ascii");
}
const expected: Record<string, string | null> = {
  "typeflag-7": "unsupported extension archive entry",
  "typeflag-K": "unsupported gnu long link archive entry",
  "typeflag-g": "unsupported pax archive entry",
  "octal-whitespace": null, "octal-bom": null, "manifest-bom": null,
  "entry-count-10000": null, "entry-count-10001": "archive entry count exceeds 10000",
};
function verify(row: { name: string; base64: string; error: string | null }) {
  let error: string | null = null;
  try { inspectArchive(Buffer.from(row.base64, "base64")); }
  catch (e) { error = (e as Error).message; }
  assert.equal(error, row.error, row.name);
}
for (const row of archives.entries) {
  if (!Object.hasOwn(expected, row.name)) continue;
  const tar = gunzipSync(Buffer.from(row.base64, "base64"));
  for (let at = 0; at + 512 <= tar.length && tar[at];) {
    const h = tar.subarray(at, at + 512);
    checksum(h);
    const size = parseInt(h.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim(), 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  row.base64 = gzipSync(tar).toString("base64");
  row.error = expected[row.name];
  verify(row); // Never silently bless an earlier parser failure.
}
// Unknown manifest fields still pass through JSON.parse before schema stripping.
const validTar = gunzipSync(Buffer.from(archives.entries[0].base64, "base64"));
for (const [name, addition, error] of [
  ["manifest-positive-overflow", ',"zzz":1e400', null],
  ["manifest-negative-overflow", ',"zzz":-1e400', null],
  ["manifest-string-field-overflow", ',"publisher":1e400', "manifest identity invalid"],
  ["manifest-invalid-utf8", ',"zzz":"\xff"', "invalid manifest JSON"],
] as const) {
  const chunks: Buffer[] = [];
  for (let at = 0; at + 512 <= validTar.length && validTar[at];) {
    const h = Buffer.from(validTar.subarray(at, at + 512));
    const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(), 8);
    let data = validTar.subarray(at + 512, at + 512 + size);
    if (h.subarray(0, 100).toString().includes("pacer-plugin.json")) {
      data = Buffer.from(data.toString().trimEnd().replace(/}$/, addition + "}"), "latin1");
      h.write(data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
      checksum(h);
    }
    chunks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  chunks.push(Buffer.alloc(1024));
  const row = { name, base64: gzipSync(Buffer.concat(chunks)).toString("base64"), error };
  verify(row);
  const i = archives.entries.findIndex((r: {name: string}) => r.name === name);
  if (i >= 0) archives.entries[i] = row; else archives.entries.push(row);
}
writeFileSync(archivePath, JSON.stringify(archives, null, 2) + "\n");

const grant = { version: "1.0.0", capabilities: [], surfaces: ["activity"], policy: true };
const prefix = "planner: claude-code\nproviders:\n  claude-code: {}\n";
const cases = [];
for (const section of [
  "plugins:\n  installed:\n    other:\n      version: 1.0.0\n      capabilities: []\n  disabled:\n    - other\n",
  "plugins:\n  installed:\n    other:\n      version: 1.0.0\n      capabilities: []\n  disabled:\n    - other\n  # trailing plugin comment\n",
  "", "# trailing document comment\n",
]) {
  let before = prefix + section;
  const disabled = section.startsWith("plugins:") ? ["other"] : [];
  for (const op of ["enable", "disable", "remove"] as const) {
    const doc = new StrategyDoc(before);
    if (op === "enable") doc.setIn(["plugins", "installed", "fx-ui"], grant);
    if (op === "disable") doc.setIn(["plugins", "disabled"], [...disabled, "fx-ui"]);
    if (op === "remove") {
      doc.setIn(["plugins", "disabled"], disabled);
      doc.deleteIn(["plugins", "installed", "fx-ui"]);
    }
    const after = doc.toString();
    cases.push({ name: `${cases.length}-${op}`, op, before, after, grant, disabled: op === "disable" ? [...disabled, "fx-ui"] : disabled });
    before = after;
  }
}
const publicGrant = { version: "1.0.0", capabilities: ["config.get"], surfaces: ["activity", "panelTabs", "settings", "status"], policy: false };
const before = prefix + "# keep me\n";
const doc = new StrategyDoc(before);
doc.setIn(["plugins", "installed", "fx-ui"], publicGrant);
cases.push({ name: "public-enable-grant-order", op: "enable", before, after: doc.toString(), grant: publicGrant, disabled: [] });
writeFileSync("test/fixtures/plugin-strategy-byte-parity.json", JSON.stringify(cases, null, 2) + "\n");
