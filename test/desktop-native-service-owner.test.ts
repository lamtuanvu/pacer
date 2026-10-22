import { expect, test } from "bun:test";
import { pairedServiceOwner, type PairedOwnerProof } from "../src/update/desktop/native-service-owner";

function proof(): PairedOwnerProof {
  const root = { pid: 201, bootId: "boot", birth: "1:0" }, core = { pid: 202, bootId: "boot", birth: "2:0" };
  return {
    core: { process: core, uid: 501, parentPid: root.pid, name: "pacer-core", executable: "/Applications/pacer.app/Contents/Resources/pacer-core" },
    front: { process: root, uid: 501, executable: "/Applications/pacer.app/Contents/Resources/pacer", role: "cli", auditToken: new Uint8Array(32) },
    own: core,
    release: { schema: 1, bundleId: "dev.pacer.desktop", version: "1.2.3", arch: "aarch64", protocolMajors: [3], admissionProtocol: 1, rollbackCompatible: true, nativeTransportAbi: 1, cliLayout: "paired" },
    argv: ["/Applications/pacer.app/Contents/Resources/pacer", "serve"], version: "1.2.3", arch: "aarch64", uid: 501, port: 7433,
  };
}

test("paired service owner is the verified direct parent while the core remains the transport", () => {
  const p = proof();
  expect(pairedServiceOwner(p)).toEqual({ process: p.front.process, executable: p.front.executable,
    argv: p.argv, transport: p.core.process, appPath: "/Applications/pacer.app" });
  p.argv = [...p.argv, "--port", "7433"];
  expect(pairedServiceOwner(p).argv).toEqual(p.argv);
});

test("paired owner rejects wrong process relationships, paths and registration arguments", () => {
  const changes: ((p: PairedOwnerProof) => void)[] = [
    p => { p.core.parentPid++; },
    p => { p.core.uid++; },
    p => { p.front.uid++; },
    p => { p.own = { ...p.own, birth: "reused" }; },
    p => { p.core = { ...p.core, process: { ...p.core.process, bootId: "other" } }; },
    p => { p.front = { ...p.front, process: p.core.process }; },
    p => { p.front.role = "desktop"; },
    p => { p.core.executable = null; },
    p => { p.core.executable = "/Applications/other.app/Contents/Resources/pacer-core"; },
    p => { p.core.executable = "/Applications/pacer.app/Contents/Resources/pacer"; },
    p => { p.front.executable = "/Applications/pacer.app/Contents/MacOS/pacer"; },
    p => { p.front.executable = "/Applications/pacer.app/Contents/Resources/../Resources/pacer"; },
    p => { p.argv = [p.front.executable, "route"]; },
    p => { p.argv = [p.front.executable, "serve", "--internal"]; },
    p => { p.argv = [p.front.executable, "serve", "--port", "7434"]; },
    p => { p.argv = [p.front.executable, "serve", "--port", "0"]; },
    p => { p.argv = ["/another/pacer", "serve"]; },
    p => { p.port = 0; },
  ];
  for (const change of changes) { const p = proof(); change(p); expect(() => pairedServiceOwner(p)).toThrow(); }
});

test("paired owner requires matching sealed release layout, version, architecture and protocol", () => {
  for (const patch of [{ cliLayout: undefined }, { cliLayout: "other" }, { version: "1.2.4" }, { arch: "x86_64" },
    { protocolMajors: [2] }, { nativeTransportAbi: 2 }, { admissionProtocol: 2 }, { rollbackCompatible: false }]) {
    const p = proof(); p.release = { ...(p.release as object), ...patch };
    expect(() => pairedServiceOwner(p)).toThrow();
  }
});
