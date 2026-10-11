import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../src/types";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pacer-test-"));
}

/** Unix seconds for a local wall-clock time (tests run with TZ=Asia/Ho_Chi_Minh). Month is 1-based. */
export function localTs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0).getTime() / 1000;
}

export function fakeCtx(o: Partial<Ctx> = {}): Ctx {
  const home = o.home ?? tmpDir();
  return {
    home,
    pacerHome: o.pacerHome ?? join(home, ".pacer"),
    now: o.now ?? localTs(2026, 10, 10, 19, 0),
    env: o.env ?? {},
    run: o.run ?? (async () => ({ code: 127, stdout: "", stderr: "not available in tests" })),
    which: o.which ?? (() => "/usr/bin/fake"),
  };
}
