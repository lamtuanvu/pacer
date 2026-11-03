import { describe, expect, test } from "bun:test";
import { assessIdentity, encodePairManifest, measurePair } from "../src/update/desktop/build-identity";

const frontDoor = { schemaVersion: 1, releaseVersion: "1.0.0", buildId: "build-a", role: "front-door", targetOs: "darwin", targetArch: "arm64" } as const;
const core = { ...frontDoor, role: "core" } as const;
const pair = (front = "front", backend = "core") => measurePair(frontDoor, core, Buffer.from(front), Buffer.from(backend));

describe("build pair identity", () => {
  test("measures both final components including dirty output", () => {
    expect(pair().core.sha256).not.toBe(pair("front", "dirty core").core.sha256);
    expect(pair().frontDoor.sha256).not.toBe(pair("dirty front", "core").frontDoor.sha256);
    expect(encodePairManifest(pair())).toBe(encodePairManifest(pair()));
    expect(encodePairManifest(pair())).not.toBe(encodePairManifest(pair("front", "other")));
    expect(Object.keys(pair().frontDoor.descriptor)).toEqual(["schemaVersion", "releaseVersion", "buildId", "role", "targetOs", "targetArch"]);
  });
  test("architecture and independent outputs affect the manifest", () => {
    const other = measurePair({ ...frontDoor, targetArch: "x64" }, { ...core, targetArch: "x64" }, Buffer.from("front"), Buffer.from("core"));
    expect(encodePairManifest(other)).not.toBe(encodePairManifest(pair()));
    expect(pair("another front", "another core")).not.toEqual(pair());
  });
  test("claims and on-disk manifests cannot establish running identity", () => {
    expect(assessIdentity(pair(), { verified: true, publisher: "trusted" }, pair())).toEqual({ status: "unverified", reason: "native-proof-unavailable" });
    expect(assessIdentity(pair(), null, pair("front", "other"))).toEqual({ status: "mismatch", reason: "pair-differs" });
  });
  test("missing, malformed or unknown schemas are unknown", () => {
    for (const input of [null, {}, { ...pair(), schemaVersion: 2 }, { ...pair(), core: { ...pair().core, sha256: "bad" } }]) {
      expect(assessIdentity(input, null, pair())).toEqual({ status: "unknown", reason: "invalid-manifest" });
    }
  });
});

test("core descriptor is readable without a front door", async () => {
  const { main } = await import("../src/cli");
  const { fakeCtx } = await import("./helpers");
  const result = await main(["--pacer-component-descriptor"], fakeCtx());
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ schemaVersion: 1, role: "core", targetOs: process.platform, targetArch: process.arch });
});

test("independent core build invocations receive distinct identities", async () => {
  const { compileCommand } = await import("../scripts/release/build");
  const { TARGETS } = await import("../src/update/manifest");
  const options = { root: "/tmp", target: TARGETS[0], version: "1.0.0", outfile: "/tmp/core" };
  const id = () => compileCommand(options).find(x => x.startsWith("PACER_COMPONENT_BUILD_ID="));
  expect(id()).not.toBe(id());
});

test("pair binding rejects tampering, missing and legacy manifests", async () => {
  const { verifyPairBinding } = await import("../src/update/desktop/build-identity");
  const manifest = encodePairManifest(pair());
  expect(verifyPairBinding(manifest, Buffer.from("front"), Buffer.from("core"))).toEqual(pair());
  for (const [data, front, backend] of [[manifest, "front!", "core"], [manifest, "front", "core!"], [null, "front", "core"], ["{}", "front", "core"], [manifest + " ", "front", "core"]] as const) {
    expect(() => verifyPairBinding(data, Buffer.from(front), Buffer.from(backend))).toThrow();
  }
});

test("extracted archive pair validation rejects altered resources and handles legacy layout", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { verifyAppPairBinding } = await import("../scripts/release/desktop-verify");
  const app = mkdtempSync(join(tmpdir(), "pacer-pair-test-")), resources = join(app, "Contents/Resources");
  try {
    mkdirSync(resources, { recursive: true });
    const legacy = { version: "1.0.0", cliLayout: "paired" };
    const metadata = { ...legacy, pairManifestVersion: 1 };
    writeFileSync(join(resources, "pacer"), "front");
    writeFileSync(join(resources, "pacer-core"), "core");
    expect(() => verifyAppPairBinding(app, legacy, "aarch64")).not.toThrow();
    expect(() => verifyAppPairBinding(app, metadata, "aarch64")).toThrow();
    expect(() => verifyAppPairBinding(app, { ...legacy, pairManifestVersion: 2 }, "aarch64")).toThrow();
    writeFileSync(join(resources, "pacer-pair-manifest.json"), encodePairManifest(pair()));
    expect(() => verifyAppPairBinding(app, legacy, "aarch64")).toThrow();
    expect(() => verifyAppPairBinding(app, metadata, "aarch64")).not.toThrow();
    expect(() => verifyAppPairBinding(app, metadata, "x86_64")).toThrow();
    writeFileSync(join(resources, "pacer-core"), "tampered");
    expect(() => verifyAppPairBinding(app, metadata, "aarch64")).toThrow();
    expect(() => verifyAppPairBinding(app, { version: "1.0.0" }, "aarch64")).toThrow();
    rmSync(join(resources, "pacer-core")); rmSync(join(resources, "pacer-pair-manifest.json"));
    expect(() => verifyAppPairBinding(app, { version: "1.0.0" }, "aarch64")).not.toThrow();
  } finally { rmSync(app, { recursive: true, force: true }); }
});
