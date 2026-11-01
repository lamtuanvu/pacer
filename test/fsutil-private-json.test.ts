import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../src/fsutil";
import { appendOutbox } from "../src/link/store";
import { outboxPath } from "../src/link/paths";
import { fakeCtx, tmpDir } from "./helpers";

test.each([0o022, 0o077])("JSON state writes stay private under umask %o", mask => {
  const previous = process.umask(mask);
  try {
    const parent = join(tmpDir(), "state");
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755);
    const path = join(parent, "data.json");
    writeFileSync(path, "old", { mode: 0o644 });
    chmodSync(path, 0o644);
    const legacyTemp = `${path}.${process.pid}.tmp`;
    writeFileSync(legacyTemp, "sentinel", { mode: 0o600 });
    writeJsonAtomic(path, { value: 1 });
    expect(readFileSync(path, "utf8")).toBe('{"value":1}');
    expect(readFileSync(legacyTemp, "utf8")).toBe("sentinel");
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(previous);
  }
});

test.each([0o022, 0o077])("outbox state writes stay private under umask %o", mask => {
  const previous = process.umask(mask);
  try {
    const ctx = fakeCtx();
    const parent = join(ctx.pacerHome, "link");
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    chmodSync(parent, 0o755);
    writeFileSync(outboxPath(ctx), "", { mode: 0o644 });
    chmodSync(outboxPath(ctx), 0o644);
    appendOutbox(ctx, [{ seq: 1, at: ctx.now, envelope: { type: "config", data: { area: "config", at: ctx.now } } }]);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(statSync(outboxPath(ctx)).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(previous);
  }
});
