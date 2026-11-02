import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFs, stuckIO, waitingFor, WAITING_AFTER_MS } from "../src/core/path-probe";

test("a stuck repo read is reported as waiting, shared by callers, and cleared when it returns", async () => {
  expect(WAITING_AFTER_MS).toBe(10_000);
  const dir = mkdtempSync(join(tmpdir(), "pacer-waiting-")), fifo = join(dir, "HEAD");
  try {
    Bun.spawnSync(["mkfifo", fifo]);
    const first = repoFs.readText(fifo), second = repoFs.readText(fifo);
    // Identical calls share one threadpool operation instead of piling up stuck threads.
    expect(second).toBe(first);
    const mine = (now?: number) => stuckIO(now).filter(entry => entry.path === fifo);
    expect(mine()).toEqual([]);
    expect(mine(Date.now() + 1_000)).toEqual([]);
    const [entry] = mine(Date.now() + WAITING_AFTER_MS);
    expect(entry).toBeDefined();
    expect(mine(entry!.since + 9_999)).toEqual([]);
    expect(mine(entry!.since + 10_000)).toHaveLength(1);
    // A writer releases the open, like a click on the macOS prompt.
    const writer = Bun.spawn(["/bin/sh", "-c", `printf 'ref: refs/heads/main\\n' > '${fifo}'`]);
    expect(await first).toBe("ref: refs/heads/main\n");
    await writer.exited;
    expect(mine(Date.now() + WAITING_AFTER_MS)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("waiting paths under /Volumes report the volume root", async () => {
  expect(waitingFor("/Volumes/LaCie/work/repo/.git/HEAD", 1_792_000_000_500)).toEqual({ kind: "volume", path: "/Volumes/LaCie", since: 1_792_000_000 });
  expect(waitingFor("/Users/me/repo", 1_000)).toEqual({ kind: "folder", path: "/Users/me/repo", since: 1 });
});
