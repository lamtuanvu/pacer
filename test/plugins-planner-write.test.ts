import { expect, test } from "bun:test";
import { writeFile, stat, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createCallAuthority } from "../src/plugins/authority";
import {
  prepareWriteAuthority,
  writeOwnerFile,
} from "../src/plugins/capability-write";

test("private retained writer restores executable owner bits while peer writer remains restrictive", async () => {
  const ctx = fakeCtx(),
    path = join(ctx.home, "backup");
  const owner = createCallAuthority(
    ctx,
    {
      reads: [],
      commands: [],
      stores: [],
      writes: [{ path, root: ctx.home, kind: "file", operations: ["write"] }],
    },
    { deadlineMs: Date.now() + 30000, grants: ["fs.write"] },
  );
  try {
    await writeFile(path, "before", { mode: 0o600 });
    await prepareWriteAuthority(owner);
    await writeOwnerFile(owner, [path], path, "restored", 0o700);
    expect(await readFile(path, "utf8")).toBe("restored");
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    await writeOwnerFile(owner, [path], path, "restored", 0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    await expect(
      writeOwnerFile(owner, [path], path, "forged", 0o777),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(path, "utf8")).toBe("restored");
  } finally {
    await owner.revoke();
    await rm(ctx.home, { recursive: true, force: true });
  }
});

test("private write compares opened before bytes and mode at its own effect boundary", async () => {
  const ctx = fakeCtx(),
    path = join(ctx.home, "config");
  await writeFile(path, "unchanged", { mode: 0o700 });
  const owner = createCallAuthority(
    ctx,
    {
      reads: [],
      commands: [],
      stores: [],
      writes: [{ path, root: ctx.home, kind: "file", operations: ["write"] }],
    },
    { deadlineMs: Date.now() + 30000, grants: ["fs.write"] },
  );
  try {
    await prepareWriteAuthority(owner);
    await expect(
      writeOwnerFile(owner, [path], path, "must not apply", 0o600, {
        text: "unchanged",
        mode: 0o600,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path, "utf8")).toBe("unchanged");
    await expect(
      writeOwnerFile(owner, [path], path, "must not apply", 0o600, {
        text: "forged",
        mode: 0o700,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path, "utf8")).toBe("unchanged");
  } finally {
    await owner.revoke();
    await rm(ctx.home, { recursive: true, force: true });
  }
});
