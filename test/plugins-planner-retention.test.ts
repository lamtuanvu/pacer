import { expect, test } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { readManifest, writeManifest } from "../src/install/manifest";
import { uninstallLegacyPluginRecord } from "../src/install/legacy-plugin-undo";
import { uninstallAll } from "../src/install/uninstall-all";

for (const variant of ["missing-backup", "occupied"] as const)
  test(`reserved legacy ${variant} preparation preserves all files, manifest and all cleanup retry state`, async () => {
    const ctx = fakeCtx({ which: () => null }),
      root = join(ctx.pacerHome, "orca-plugin"),
      path = join(root, "worker.mjs"),
      backup = join(root, "worker.mjs.pacer-bak-20261010-190000"),
      other = join(root, "safe-created"),
      binary = join(ctx.home, "pacer");
    await mkdir(root, { recursive: true });
    await writeFile(other, "safe-owned");
    await writeFile(binary, "owned synthetic binary");
    ctx.env.PACER_BIN = binary;
    if (variant === "occupied") {
      await writeFile(path, "intervening-user-file");
      await writeFile(backup, "original-backup");
    }
    const { sha256 } = await import("../src/install/fsx");
    writeManifest(ctx, {
      version: 1,
      planners: {
        "orca-plugin": {
          planner: "orca-plugin",
          installedAt: ctx.now,
          pacerArgv: [binary],
          commands: [],
          notes: ["user note must not decide cleanup"],
          files: [
            { path, backup, action: "moved", undo: [] },
            {
              path: other,
              action: "created",
              undo: [],
              afterHash: sha256("safe-owned"),
            },
          ],
        },
      },
    });
    const manifest = await readFile(
      join(ctx.pacerHome, "install-manifest.json"),
      "utf8",
    );
    await expect(uninstallLegacyPluginRecord(ctx)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8"),
    ).toBe(manifest);
    expect(await readFile(other, "utf8")).toBe("safe-owned");
    let homeRemoved = false,
      binaryRemoved = false;
    const result = await uninstallAll(
      ["--all", "--yes", "--binary", "--json"],
      ctx,
      {
        removeHome: () => {
          homeRemoved = true;
        },
        removeBinary: () => {
          binaryRemoved = true;
        },
      },
    );
    expect(result.code).toBe(1);
    expect(homeRemoved).toBe(false);
    expect(binaryRemoved).toBe(false);
    expect(readManifest(ctx).planners["orca-plugin"]).toBeDefined();
    expect(
      await readFile(join(ctx.pacerHome, "install-manifest.json"), "utf8"),
    ).toBe(manifest);
    expect(await readFile(other, "utf8")).toBe("safe-owned");
    expect(await readFile(binary, "utf8")).toBe("owned synthetic binary");
    expect(
      await Bun.file(join(ctx.pacerHome, "install-transaction.json")).exists(),
    ).toBe(false);
    if (variant === "occupied") {
      expect(await readFile(path, "utf8")).toBe("intervening-user-file");
      expect(await readFile(backup, "utf8")).toBe("original-backup");
    }
  });

test("SDK preparation reports typed incomplete outcomes without changing candidate wire shape or notes", async () => {
  const { preparePlannerUninstallFiles } = await import(
    "../packages/plugin-sdk/src/install/uninstall"
  );
  const failures: { path: string; reason: string }[] = [];
  const plan = await preparePlannerUninstallFiles(
    {
      read: async (path) => {
        if (path === "/read-error") throw Error("synthetic read failure");
        if (path === "/edited") return { text: "managed", mode: 0o600 };
        return null;
      },
    },
    {
      planner: "orca-plugin",
      installedAt: 1,
      pacerArgv: [],
      commands: [],
      notes: ["unrelated user note"],
      files: [
        { path: "/read-error", action: "created", undo: [] },
        { path: "/moved", action: "moved", backup: "/missing", undo: [] },
        {
          path: "/edited",
          action: "edited",
          backup: "/missing",
          exact: true,
          afterHash: (await import("../src/install/fsx")).sha256("managed"),
          undo: [],
        },
      ],
    },
    { onIncomplete: (failure) => failures.push(failure) },
  );
  expect(failures).toEqual([
    { path: "/edited", reason: "missing_backup" },
    { path: "/moved", reason: "missing_backup" },
    { path: "/read-error", reason: "read_error" },
  ]);
  expect(Object.keys(plan).sort()).toEqual([
    "files",
    "notes",
    "record",
    "schema",
    "touched",
    "uninstallReport",
  ]);
  expect(plan.notes).toContain(
    "cannot restore /moved; backup kept at /missing",
  );
});
