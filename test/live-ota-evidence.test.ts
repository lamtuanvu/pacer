import { expect, test } from "bun:test";
import { writeFileSync, symlinkSync, linkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { privateFixtureBytes } from "../scripts/live/ota-exercise";
test("private evidence reads reject symlinks, shared inodes, public files and oversized contents", () => {
  const root = realpathSync(tmpDir()), file = join(root, "record"), link = join(root, "link");
  writeFileSync(file, "exact", { mode: 0o600 });
  expect(privateFixtureBytes(file, 16).toString()).toBe("exact");
  expect(() => privateFixtureBytes(file, 2)).toThrow();
  symlinkSync(file, link); expect(() => privateFixtureBytes(link, 16)).toThrow();
  linkSync(file, join(root, "hardlink")); expect(() => privateFixtureBytes(file, 16)).toThrow();
  const publicFile = join(root, "public"); writeFileSync(publicFile, "data", { mode: 0o644 });
  expect(() => privateFixtureBytes(publicFile, 16)).toThrow();
});
test("special evidence file refuses without blocking", async () => {
  const root = realpathSync(tmpDir()), fifo = join(root, "pipe");
  expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0);
  const code = 'import {privateFixtureBytes} from "./scripts/live/ota-exercise.ts";try{privateFixtureBytes(process.argv[1],32);process.exit(1)}catch{process.exit(0)}';
  const child = Bun.spawn([process.execPath, "-e", code, fifo], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 2000 });
  expect(await child.exited).toBe(0);
});
