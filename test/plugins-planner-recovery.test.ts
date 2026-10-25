import { expect, test } from "bun:test";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { recoverPlannerInstall } from "../src/plugins/planner-recovery";
import { withInstallLock } from "../src/install/lock";
import { sha256 } from "../src/install/fsx";

test("owned real parent kill and restart recovers schema1 FILE journal without plugin", async () => {
  const ctx = fakeCtx(),
    folder = join(ctx.home, ".codex");
  await mkdir(folder);
  await mkdir(ctx.pacerHome);
  await writeFile(join(folder, "settings.json"), "before", { mode: 0o700 });
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/sp06-rpc/parent.ts"),
      "crash",
      ctx.home,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "" },
    },
  );
  try {
    const reader = child.stdout.getReader();
    let text = "";
    while (!text.includes("APPLIED\n")) {
      const result = await reader.read();
      if (result.done) throw Error("parent ended before admitted apply");
      text += new TextDecoder().decode(result.value);
    }
    child.kill("SIGKILL");
    await child.exited;
    expect(await readFile(join(folder, "settings.json"), "utf8")).toBe(
      "installed",
    );
    expect(
      await Bun.file(join(ctx.pacerHome, "install-transaction.json")).exists(),
    ).toBe(true);
    const restarted = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/sp06-rpc/parent.ts"),
        "recover",
        ctx.home,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "" },
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(restarted.stdout).text(),
      new Response(restarted.stderr).text(),
      restarted.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out)).toEqual({ text: "before", mode: 0o700 });
    expect(
      await Bun.file(join(ctx.pacerHome, "install-transaction.json")).exists(),
    ).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(ctx.home, { recursive: true, force: true });
  }
});
test("recovery checks every destination before any restoration effect", async () => {
  const ctx = fakeCtx(),
    folder = join(ctx.home, ".codex");
  await mkdir(folder);
  await mkdir(ctx.pacerHome);
  const a = join(folder, "a"),
    b = join(folder, "b");
  await writeFile(a, "after");
  await writeFile(b, "user edit");
  await writeFile(
    join(ctx.pacerHome, "install-transaction.json"),
    JSON.stringify({
      schema: 1,
      manifestHash: sha256("uncommitted"),
      files: [
        { path: a, before: "before", after: "after", beforeMode: 0o600 },
        { path: b, before: "before", after: "after", beforeMode: 0o600 },
      ],
    }),
  );
  try {
    await expect(
      withInstallLock(ctx, () => recoverPlannerInstall(ctx)),
    ).rejects.toThrow("changed during recovery");
    expect(await readFile(a, "utf8")).toBe("after");
    expect(await readFile(b, "utf8")).toBe("user edit");
    expect(
      await Bun.file(join(ctx.pacerHome, "install-transaction.json")).exists(),
    ).toBe(true);
  } finally {
    await rm(ctx.home, { recursive: true, force: true });
  }
});
