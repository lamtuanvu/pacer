import { afterEach, expect, test } from "bun:test";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import {
  createCallAuthority,
  type CallAuthority,
} from "../src/plugins/authority";
import {
  answerFilesystem,
  prepareFilesystemAuthority,
} from "../src/plugins/capability-fs";

const owners: CallAuthority[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    await owner.revoke();
    await rm(owner.ctx.home, { recursive: true, force: true });
  }
});
async function fixture(text = "executable") {
  const ctx = fakeCtx(),
    path = join(ctx.home, "planner-config");
  await writeFile(path, text, { mode: 0o700 });
  const owner = createCallAuthority(
    ctx,
    { reads: [{ path, kind: "file" }], commands: [], stores: [] },
    { deadlineMs: Date.now() + 30000, grants: ["fs.read"] },
  );
  owners.push(owner);
  await prepareFilesystemAuthority(owner);
  const read = (method: string, params: Record<string, unknown>) =>
    answerFilesystem(owner, [path], method, params) as Promise<any>;
  return { path, read };
}
test("inline installation images carry the opened descriptor permission mode", async () => {
  const { path, read } = await fixture();
  const image = await read("capability.fs.read", { path });
  expect(image.text).toBe("executable");
  expect(image.mode & 0o777).toBe(0o700);
});
test("ranged installation images reject chmod-only observation changes", async () => {
  const { path, read } = await fixture("x".repeat(300000));
  const { ranged: expected } = await read("capability.fs.read", { path });
  expect(expected.mode & 0o777).toBe(0o700);
  await chmod(path, 0o600);
  await expect(
    read("capability.fs.readRange", {
      path,
      offset: 0,
      length: 262144,
      expected,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});
test("each range rejects a supplied mismatching mode even with unchanged bytes", async () => {
  const { path, read } = await fixture("x".repeat(300000));
  const { ranged } = await read("capability.fs.read", { path });
  await expect(
    read("capability.fs.readRange", {
      path,
      offset: 0,
      length: 1,
      expected: { ...ranged, mode: 0o600 },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});
test("chmod during the actual opened descriptor read is a conflict", async () => {
  const { spyOn } = await import("bun:test"),
    { open } = await import("node:fs/promises");
  const { path, read } = await fixture("x".repeat(1000));
  const probe = await open(path, "r"),
    prototype = Object.getPrototypeOf(probe),
    original = prototype.read;
  await probe.close();
  let changed = false;
  const interception = spyOn(prototype, "read").mockImplementation(
    async function (this: any, ...args: any[]) {
      const result = await original.apply(this, args);
      if (!changed) {
        changed = true;
        await chmod(path, 0o600);
      }
      return result;
    },
  );
  try {
    await expect(read("capability.fs.read", { path })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(changed).toBe(true);
  } finally {
    interception.mockRestore();
  }
});
