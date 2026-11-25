import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An executable stand-in for the native `pacer-assistant-pacer` sibling.
 *
 * `PACER_ASSISTANT_PACER_BIN` skips the sibling version guard, so the front doors can
 * point at this stub. Its absolute shebang imports the protocol peer directly: plugin
 * children start with an empty environment, both under Core and under the native owner,
 * so a `/usr/bin/env bun` script would not find the runtime.
 */
const dir = mkdtempSync(join(tmpdir(), "pacer-ap-bin-"));
export const assistantPacerStubBin = join(dir, "pacer-assistant-pacer");
writeFileSync(assistantPacerStubBin, `#!${process.execPath}\nimport ${JSON.stringify(join(import.meta.dir, "peer.ts"))};\n`, { mode: 0o755 });
