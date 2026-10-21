import { validatePng } from "../../../src/desktop/png";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { recordProvenance } from "./provenance";
import { record, type Session } from "../core";
import { ControlError, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, type Artifact, type ControlResult } from "./contract";
import type { SaveCapture } from "./dispatch";

export function createCaptureWriter(session: Session): SaveCapture {
  return async (capture, _target, commandId): Promise<Artifact> => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(commandId)) throw new ControlError("capture_invalid", "invalid artifact id");
    if (capture.bytes.byteLength > MAX_IMAGE_BYTES) throw new ControlError("capture_invalid", "artifact exceeds size cap");
    if (capture.mime === "image/png") {
      const { width, height } = validatePng(capture.bytes);
      capture.width = width; capture.height = height;
    }
    const directory = join(session.root, "evidence", "captures"); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = `captures/${commandId}.${capture.mime === "image/png" ? "png" : "txt"}`;
    writeFileSync(join(session.root, "evidence", path), capture.bytes, { flag: "wx", mode: 0o600 });
    const artifact: Artifact = { id: commandId, path, sha256: createHash("sha256").update(capture.bytes).digest("hex"),
      method: capture.method, mime: capture.mime, at: new Date().toISOString(), width: capture.width, height: capture.height, scale: capture.scale, bounds: _target.bounds, producer: capture.producer };
    record(session, { kind: "capture", path, text: `${artifact.method}; sha256 ${artifact.sha256}` });
    return artifact;
  };
}
export function recordStep(session: Session, result: ControlResult): void {
  result.provenance ??= recordProvenance(session);
  const directory = join(session.root, "evidence", "steps"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${result.command_id}.json`), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (result.verdict) record(session, { kind: "note", behavior: result.command, surface: result.target?.surface,
    verdict: result.verdict, steps: result.command_id, text: result.error?.message ?? `Observed ${result.observation?.revision ?? "state"}; see step evidence` });
}
