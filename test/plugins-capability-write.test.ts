import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCallAuthority,
  type CallAuthority,
  type CallResources,
} from "../src/plugins/authority";
import {
  answerWrite,
  prepareWriteAuthority,
} from "../src/plugins/capability-write";
import { fakeCtx } from "./helpers";
const owners: CallAuthority[] = [],
  roots: string[] = [];
afterEach(async () => {
  try {
    await Promise.all(owners.splice(0).map((a) => a.revoke()));
  } finally {
    for (const p of roots.splice(0))
      fs.rmSync(p, { recursive: true, force: true });
  }
});
function fixture(
  writes: (root: string) => NonNullable<CallResources["writes"]>,
  grants = ["fs.write"],
) {
  const root = fs.mkdtempSync(join(tmpdir(), "pacer-write-"));
  roots.push(root);
  const home = join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const ctx = fakeCtx({ home, pacerHome: home });
  const resources = {
    reads: [],
    commands: [],
    stores: [],
    writes: writes(home),
  };
  const owner = createCallAuthority(ctx, resources, {
    grants,
    deadlineMs: Date.now() + 10000,
  });
  owners.push(owner);
  return { root, home, ctx, owner };
}
const file = (root: string) => join(root, "file");
test("atomic UTF8 write is0600 and same bytes preserve inode/mtime while repairing mode", async () => {
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  await prepareWriteAuthority(f.owner);
  expect(
    await answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
      path: file(f.home),
      text: "界\0text",
    }),
  ).toEqual({ ok: true });
  expect(fs.readFileSync(file(f.home), "utf8")).toBe("界\0text");
  expect(fs.statSync(file(f.home)).mode & 0o777).toBe(0o600);
  const before = fs.statSync(file(f.home));
  fs.chmodSync(file(f.home), 0o644);
  expect(
    await answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
      path: file(f.home),
      text: "界\0text",
    }),
  ).toEqual({ ok: true });
  const after = fs.statSync(file(f.home));
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(f.home)).toEqual(["file"]);
});
test("each missing ancestor needs its own issued mkdir and directories are0700", async () => {
  const f = fixture((root) => [
    { path: join(root, "dir"), kind: "directory", operations: ["mkdir"] },
    { path: join(root, "dir/file"), kind: "file", operations: ["write"] },
  ]);
  await prepareWriteAuthority(f.owner);
  await expect(
    answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
      path: join(f.home, "dir/file"),
      text: "x",
    }),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(
    await answerWrite(f.owner, [f.home + "/**"], "capability.fs.mkdir", {
      path: join(f.home, "dir"),
    }),
  ).toEqual({ ok: true });
  expect(fs.statSync(join(f.home, "dir")).mode & 0o777).toBe(0o700);
  await answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
    path: join(f.home, "dir/file"),
    text: "x",
  });
  expect(fs.readFileSync(join(f.home, "dir/file"), "utf8")).toBe("x");
});
test("grant, declared scope, exact resource and operation intersect without ambient directory authority", async () => {
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  await prepareWriteAuthority(f.owner);
  for (const [scopes, method, params] of [
    [[], "capability.fs.write", { path: file(f.home), text: "x" }],
    [
      [f.home + "/**"],
      "capability.fs.write",
      { path: join(f.home, "other"), text: "x" },
    ],
    [[f.home + "/**"], "capability.fs.remove", { path: file(f.home) }],
  ] as const)
    await expect(
      answerWrite(f.owner, scopes, method, params),
    ).rejects.toMatchObject({ code: "capability_denied" });
  const no = fixture(
    (root) => [{ path: file(root), kind: "file", operations: ["write"] }],
    [],
  );
  await prepareWriteAuthority(no.owner);
  await expect(
    answerWrite(no.owner, [no.home + "/**"], "capability.fs.write", {
      path: file(no.home),
      text: "x",
    }),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(fs.readdirSync(f.home)).toEqual([]);
});
test("complete UTF8 text cap is4MiB and rejects overflow before creating temporary files", async () => {
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  await prepareWriteAuthority(f.owner);
  const text = "界".repeat(1398101) + "a";
  await answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
    path: file(f.home),
    text,
  });
  expect(fs.statSync(file(f.home)).size).toBe(4194304);
  await expect(
    answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
      path: file(f.home),
      text: text + "a",
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(fs.readdirSync(f.home)).toEqual(["file"]);
});
test("descendant symlinks and hardlinked files are refused without changing outside bytes", async () => {
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write", "remove"] },
  ]);
  const outside = join(f.root, "outside");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, file(f.home));
  await expect(prepareWriteAuthority(f.owner)).rejects.toMatchObject({
    code: "capability_denied",
  });
  expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  const h = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  fs.linkSync(outside, file(h.home));
  await expect(prepareWriteAuthority(h.owner)).rejects.toMatchObject({
    code: "capability_denied",
  });
  expect(fs.readFileSync(outside, "utf8")).toBe("outside");
});
test("parent replacement after issuance never redirects effects into victim", async () => {
  const f = fixture((root) => [
    { path: join(root, "dir/file"), kind: "file", operations: ["write"] },
  ]);
  fs.mkdirSync(join(f.home, "dir"));
  const victim = join(f.root, "victim");
  fs.mkdirSync(victim);
  fs.writeFileSync(join(victim, "file"), "victim");
  await prepareWriteAuthority(f.owner);
  fs.renameSync(join(f.home, "dir"), join(f.home, "moved"));
  fs.symlinkSync(victim, join(f.home, "dir"));
  await expect(
    answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
      path: join(f.home, "dir/file"),
      text: "replacement",
    }),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(fs.readFileSync(join(victim, "file"), "utf8")).toBe("victim");
});

test("nonmutating transport check requires preparation and exact write scope", async () => {
  const { checkWriteAuthority } = await import(
    "../src/plugins/capability-write"
  );
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  expect(() =>
    checkWriteAuthority(f.owner, [f.home + "/**"], file(f.home), "write"),
  ).toThrow();
  await prepareWriteAuthority(f.owner);
  checkWriteAuthority(f.owner, [f.home + "/**"], file(f.home), "write");
  expect(fs.readdirSync(f.home)).toEqual([]);
  expect(() =>
    checkWriteAuthority(
      f.owner,
      [file(f.home) + "/child"],
      file(f.home),
      "write",
    ),
  ).toThrow();
});
test("recursive remove walks held directories, refuses symlinks and never traverses outside", async () => {
  const f = fixture((root) => [
    { path: join(root, "tree"), kind: "directory", operations: ["remove"] },
  ]);
  const tree = join(f.home, "tree"),
    victim = join(f.root, "victim");
  fs.mkdirSync(join(tree, "nested"), { recursive: true });
  fs.mkdirSync(victim);
  fs.writeFileSync(join(victim, "keep"), "outside");
  fs.writeFileSync(join(tree, "nested/owned"), "owned");
  fs.symlinkSync(victim, join(tree, "link"));
  await prepareWriteAuthority(f.owner);
  await expect(
    answerWrite(f.owner, [f.home + "/**"], "capability.fs.remove", {
      path: tree,
      recursive: true,
    }),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(fs.readFileSync(join(victim, "keep"), "utf8")).toBe("outside");
  fs.unlinkSync(join(tree, "link"));
  expect(
    await answerWrite(f.owner, [f.home + "/**"], "capability.fs.remove", {
      path: tree,
      recursive: true,
    }),
  ).toEqual({ ok: true });
  expect(fs.existsSync(tree)).toBe(false);
  expect(
    await answerWrite(f.owner, [f.home + "/**"], "capability.fs.remove", {
      path: tree,
      recursive: true,
    }),
  ).toEqual({ ok: true });
});
test("a parent swap at the actual rename boundary cannot redirect a staged write", async () => {
  const { writeNative } = await import("../src/plugins/write-native");
  const f = fixture((root) => [
    { path: join(root, "dir/file"), kind: "file", operations: ["write"] },
  ]);
  const dir = join(f.home, "dir"),
    victim = join(f.root, "victim");
  fs.mkdirSync(dir);
  fs.mkdirSync(victim);
  fs.writeFileSync(join(victim, "file"), "victim");
  await prepareWriteAuthority(f.owner);
  const native = writeNative(),
    rename = native.renameAt.bind(native);
  const race = spyOn(native, "renameAt").mockImplementation(
    (from, old, to, name) => {
      fs.renameSync(dir, dir + ".moved");
      fs.symlinkSync(victim, dir);
      rename(from, old, to, name);
    },
  );
  try {
    await expect(
      answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
        path: join(dir, "file"),
        text: "owned",
      }),
    ).rejects.toMatchObject({ code: "capability_denied" });
  } finally {
    race.mockRestore();
  }
  expect(fs.readFileSync(join(victim, "file"), "utf8")).toBe("victim");
  expect(fs.readFileSync(join(dir + ".moved", "file"), "utf8")).toBe("owned");
  expect(fs.readdirSync(dir + ".moved")).toEqual(["file"]);
});
test("short writes finish completely and failed partial append leaves no stage", async () => {
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  await prepareWriteAuthority(f.owner);
  const original = fs.writeSync;
  let calls = 0;
  const short = spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    buffer: any,
    offset: number,
    length: number,
    position: number,
  ) => {
    calls++;
    return original(fd, buffer, offset, Math.min(length, 3), position);
  }) as typeof fs.writeSync);
  try {
    await answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
      path: file(f.home),
      text: "long enough for short writes",
    });
  } finally {
    short.mockRestore();
  }
  expect(calls).toBeGreaterThan(1);
  expect(fs.readFileSync(file(f.home), "utf8")).toBe(
    "long enough for short writes",
  );
  calls = 0;
  const failure = spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    buffer: any,
    offset: number,
    length: number,
    position: number,
  ) => {
    if (calls++) throw Error("private fixture failure");
    return original(fd, buffer, offset, 2, position);
  }) as typeof fs.writeSync);
  try {
    await expect(
      answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
        path: file(f.home),
        text: "different replacement",
      }),
    ).rejects.toMatchObject({ code: "capability_denied" });
  } finally {
    failure.mockRestore();
  }
  expect(fs.readdirSync(f.home)).toEqual(["file"]);
  expect(fs.readFileSync(file(f.home), "utf8")).toBe(
    "long enough for short writes",
  );
});
test("revoke during staging waits for cleanup and prevents commit or later writes", async () => {
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  await prepareWriteAuthority(f.owner);
  const original = fs.writeSync;
  let revoked: Promise<void> | undefined;
  const cancel = spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    buffer: any,
    offset: number,
    length: number,
    position: number,
  ) => {
    const n = original(fd, buffer, offset, length, position);
    revoked = f.owner.revoke();
    return n;
  }) as typeof fs.writeSync);
  try {
    await expect(
      answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
        path: file(f.home),
        text: "uncommitted",
      }),
    ).rejects.toMatchObject({ code: "capability_denied" });
    await revoked;
  } finally {
    cancel.mockRestore();
  }
  expect(fs.readdirSync(f.home)).toEqual([]);
  await expect(
    answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
      path: file(f.home),
      text: "late",
    }),
  ).rejects.toMatchObject({ code: "capability_denied" });
});
test("a failed preparation is never reusable after a rejected target is replaced", async () => {
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  const outside = join(f.root, "outside");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, file(f.home));
  await expect(prepareWriteAuthority(f.owner)).rejects.toMatchObject({
    code: "capability_denied",
  });
  fs.unlinkSync(file(f.home));
  await expect(prepareWriteAuthority(f.owner)).rejects.toMatchObject({
    code: "capability_denied",
  });
  await expect(
    answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
      path: file(f.home),
      text: "late",
    }),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(fs.readFileSync(outside, "utf8")).toBe("outside");
});

test("uncertain staging cleanup rejects final revoke even after the RPC error is caught", async () => {
  const { writeNative } = await import("../src/plugins/write-native");
  const f = fixture((root) => [
    { path: file(root), kind: "file", operations: ["write"] },
  ]);
  await prepareWriteAuthority(f.owner);
  const native = writeNative();
  const failedWrite = spyOn(fs, "writeSync").mockImplementation(() => {
    throw Error("owned write fault");
  });
  const failedCleanup = spyOn(native, "unlinkAt").mockImplementation(() => {
    throw Error("owned cleanup fault");
  });
  try {
    await expect(
      answerWrite(f.owner, [f.home + "/**"], "capability.fs.write", {
        path: file(f.home),
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "plugin_unavailable" });
  } finally {
    failedWrite.mockRestore();
    failedCleanup.mockRestore();
  }
  owners.splice(owners.indexOf(f.owner), 1);
  await expect(f.owner.revoke()).rejects.toMatchObject({
    code: "plugin_unavailable",
  });
  expect(fs.existsSync(file(f.home))).toBe(false);
  expect(fs.readdirSync(f.home)).toHaveLength(1);
});
