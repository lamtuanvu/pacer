import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { withOtaLedgerLock } from "../scripts/live/ota-lock";

test("ledger flock excludes another process and releases after an exception", () => {
  const root = realpathSync(tmpDir()), module = new URL("../scripts/live/ota-lock.ts", import.meta.url).pathname;
  const attempt = () => Bun.spawnSync([process.execPath, "-e", `import {withOtaLedgerLock} from ${JSON.stringify(module)};try {withOtaLedgerLock(${JSON.stringify(root)},()=>{});}catch {process.exit(9);}`], { stdout: "pipe", stderr: "pipe" }).exitCode;
  withOtaLedgerLock(root, () => expect(attempt()).toBe(9));
  expect(attempt()).toBe(0);
  expect(() => withOtaLedgerLock(root, () => { throw Error("callback"); })).toThrow("callback");
  expect(attempt()).toBe(0);
});
test("ledger lock refuses symlink and broad permissions", () => {
  const root = realpathSync(tmpDir()); mkdirSync(join(root, "locks"), { mode: 0o700 });
  const foreign = join(root, "foreign"); writeFileSync(foreign, "", { mode: 0o600 });
  symlinkSync(foreign, join(root, "locks/ledger-lock"));
  expect(() => withOtaLedgerLock(root, () => {})).toThrow();
});
test("kernel releases fixture ledger ownership when its exact holder crashes", async () => {
  const root = realpathSync(tmpDir()), module = new URL("../scripts/live/ota-lock.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `import {withOtaLedgerLock} from ${JSON.stringify(module)};withOtaLedgerLock(${JSON.stringify(root)},()=>{process.stdout.write("held");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);});`], { stdout: "pipe", stderr: "pipe" });
  try {
    const chunk = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(chunk.value)).toBe("held");
    expect(() => withOtaLedgerLock(root, () => {})).toThrow("busy");
    child.kill("SIGKILL"); await child.exited;
    expect(withOtaLedgerLock(root, () => "recovered")).toBe("recovered");
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
});
