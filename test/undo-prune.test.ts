import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { doctor } from "../src/core/setup";
import { pruneUndoSnapshotsAtStartup, undoKeyDir, writeUndoSnapshot } from "../src/install/undo-store";
import { fakeCtx } from "./helpers";

async function promptly<T>(work: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("pruning waited for the installation lock")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const [name, prune] of [["startup prune", pruneUndoSnapshotsAtStartup], ["doctor.run", doctor]] as const) {
  test(`${name} skips expired snapshots promptly while another process owns the install lock`, async () => {
    const ctx = fakeCtx({ which: () => null });
    writeUndoSnapshot(ctx, "expired", [{ path: join(ctx.home, "config"), before: "private", after: "new" }], "rev", ctx.now - 8 * 86_400);
    const source = `
      import { withInstallLock } from ${JSON.stringify(resolve("src/install/lock.ts"))};
      await withInstallLock({ pacerHome: process.env.PACER_HOME }, async () => {
        console.log("locked");
        await Bun.stdin.text();
      });
    `;
    const holder = Bun.spawn([process.execPath, "-e", source], {
      env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = holder.stdout.getReader();
      const ready = await promptly(reader.read(), 5000);
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toBe("locked\n");
      const started = performance.now();
      await promptly<unknown>(prune(ctx));
      expect(performance.now() - started).toBeLessThan(500);
      expect(existsSync(undoKeyDir(ctx, "expired"))).toBe(true);
    } finally {
      holder.stdin.end();
      holder.kill();
      await holder.exited;
    }
  });

  test(`${name} prunes expired snapshots and keeps fresh snapshots without contention`, async () => {
    const ctx = fakeCtx({ which: () => null });
    const files = [{ path: join(ctx.home, "config"), before: "private", after: "new" }];
    writeUndoSnapshot(ctx, "fresh", files, "fresh", ctx.now);
    writeUndoSnapshot(ctx, "expired", files, "expired", ctx.now - 8 * 86_400);
    await prune(ctx);
    expect(existsSync(undoKeyDir(ctx, "expired"))).toBe(false);
    expect(existsSync(undoKeyDir(ctx, "fresh"))).toBe(true);
  });
}
