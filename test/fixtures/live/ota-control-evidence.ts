import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { OtaControlEvidence } from "../../../scripts/live/control/ota-binding-proof";

export const hash = "a".repeat(64);
const desktop = { pid: 4321, bootId: "boot", birth: "100:200" };
const service = { pid: 4322, bootId: "boot", birth: "101:200" };
export function fixture(): OtaControlEvidence {
  const root = join(tmpdir(), "pacer-ota-control-proof", "ota"), app = join(root, "current.app"), home = join(dirname(root), "home");
  return {
    state: { sessionId: "fixture", root, phase: "prepared", currentApp: app, pacerHome: home,
      nativeFixture: { candidateVersion: "0.2.4" }, serviceLabel: "service", recoveryLabel: "recovery",
      exercise: { scenario: "upgrade", state: "complete", installationId: hash, transactionId: "transaction", faults: [] },
      runtime: { state: "managed", request: null }, registrations: [
        { label: "service", state: "loaded", sha256: hash, processes: [service] },
        { label: "recovery", state: "retired", processes: [] },
      ],
    },
    transaction: { authorization: { kind: "install" }, digest: hash,
      command: { installationId: hash, transactionId: "transaction", target: { id: hash, ownership: "managed", appPath: app, pacerHome: home }, candidate: { version: "0.2.4" } },
      record: { installationId: hash, transactionId: "transaction", phase: "complete" },
      journal: { state: "committed", manifestSha256: hash, verificationProof: { installationId: hash, transactionId: "transaction", desktop, service, nativeSessionId: "native", desktopVersion: "0.2.4", serviceVersion: "0.2.4", protocol: 3, desktopSignedIn: true, validStateRead: true }, steps: ["release-reservation", "retire-recovery"].map(kind => ({ action: { kind }, evidence: { kind: "complete" } })) },
    },
    jobs: { schema: 1, desktops: [desktop], jobs: [
      { label: "service", state: "loaded", loaded: true, process: service, executable: `${app}/Contents/Resources/pacer`, registrationSha256: hash },
      { label: "recovery", state: "retired", loaded: false, process: null },
    ] },
    processes: [
      { process: desktop, uid: 501, executable: `${app}/Contents/MacOS/pacer` },
      { process: service, uid: 501, executable: `${app}/Contents/Resources/pacer` },
    ],
    identity: { pid: desktop.pid, start_identity: desktop.birth }, appSha256: hash,
    captures: [{ pid: desktop.pid, window_id: "123", label: "main", client_id: "capture-client" }],
    clients: [{ kind: "desktop", version: "0.2.4", client_id: "capture-client" }],
  } as unknown as OtaControlEvidence;
}
