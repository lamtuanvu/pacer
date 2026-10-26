import { afterEach, expect, test } from "bun:test";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import { PlannerResources } from "../src/plugins/planner-resources";
import type { PluginManifest } from "../src/plugins/protocol";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(
  purpose: "install" | "reconcile" | "uninstall" = "install",
  script?: string,
) {
  const ctx = fakeCtx(),
    binary = join(ctx.home, "sp06-tool"),
    effect = join(ctx.home, "effect");
  await writeFile(
    binary,
    `#!${process.execPath}\n${script ?? "const fs=require('node:fs');fs.writeFileSync(process.argv[2],process.argv[3]);console.log('actual command');"}`,
    { mode: 0o700 },
  );
  ctx.which = (name) => (name === "sp06-tool" ? binary : null);
  const manifest: PluginManifest = {
    id: "sp06-rpc",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1",
    contributes: { planner: {} },
    capabilities: [{ name: "process.spawn", scopes: ["sp06-tool"] }],
    tier: "free",
    reentrant: false,
  };
  const registry = new PluginRegistry({
    bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({
      argv: [
        process.execPath,
        join(import.meta.dir, "fixtures/sp06-rpc/command.ts"),
      ],
      cwd: ctx.home,
      env: { PATH: process.env.PATH },
    }),
  });
  const resources = new PlannerResources(ctx, {
    purpose,
    binaries: ["sp06-tool"],
    cwd: ctx.home,
  });
  cleanups.push(async () => {
    await resources.dispose();
    await registry.shutdown();
    await rm(ctx.home, { recursive: true, force: true });
  });
  return { ctx, registry, resources, binary, effect };
}
test("actual child install command runs and retained undo survives peer admission revoke", async () => {
  const f = await fixture();
  const result = await f.registry.call<any>(
    f.ctx,
    "sp06-rpc",
    "planner.install",
    {
      intent: {
        argv: [f.binary, f.effect, "forward"],
        undo: [f.binary, f.effect, "undo"],
        timeoutMs: 30000,
      },
    },
    { plannerResources: f.resources },
  );
  expect(result.stdout).toBe("actual command\n");
  expect(await readFile(f.effect, "utf8")).toBe("forward");
  await f.resources.rollback();
  expect(await readFile(f.effect, "utf8")).toBe("undo");
});
for (const method of ["planner.plan", "planner.detect", "planner.check"])
  test(`actual child ${method} cannot borrow installation effects even with process grant`, async () => {
    const f = await fixture();
    await expect(
      f.registry.call(
        f.ctx,
        "sp06-rpc",
        method,
        { intent: { argv: [f.binary, f.effect, "forged"], timeoutMs: 30000 } },
        { plannerResources: f.resources },
      ),
    ).rejects.toMatchObject({ code: "capability_denied" });
    expect(await Bun.file(f.effect).exists()).toBe(false);
  });
test("reconcile refuses actual command before effects", async () => {
  const f = await fixture("reconcile");
  await expect(
    f.registry.call(
      f.ctx,
      "sp06-rpc",
      "planner.install",
      { intent: { argv: [f.binary, f.effect, "forged"], timeoutMs: 30000 } },
      { plannerResources: f.resources },
    ),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(await Bun.file(f.effect).exists()).toBe(false);
});
test("actual child cannot substitute arbitrary absolute binary or undeclared command", async () => {
  const f = await fixture();
  await expect(
    f.registry.call(
      f.ctx,
      "sp06-rpc",
      "planner.install",
      {
        intent: {
          argv: [process.execPath, "-e", "process.exit(0)"],
          timeoutMs: 30000,
        },
      },
      { plannerResources: f.resources },
    ),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(await Bun.file(f.effect).exists()).toBe(false);
});
test("retained compensation rejects executable replacement after peer revocation", async () => {
  const f = await fixture();
  await f.registry.call(
    f.ctx,
    "sp06-rpc",
    "planner.install",
    {
      intent: {
        argv: [f.binary, f.effect, "forward"],
        undo: [f.binary, f.effect, "undo"],
        timeoutMs: 30000,
      },
    },
    { plannerResources: f.resources },
  );
  await writeFile(
    f.binary,
    `#!${process.execPath}\nthrow Error('replacement must not run');`,
    { mode: 0o700 },
  );
  await expect(f.resources.rollback()).rejects.toMatchObject({
    code: "plugin_unavailable",
  });
  expect(await readFile(f.effect, "utf8")).toBe("forward");
});
test("same private owner cannot be rebound to a later peer call", async () => {
  const f = await fixture();
  await f.registry.call(
    f.ctx,
    "sp06-rpc",
    "planner.install",
    { intent: { argv: [f.binary, f.effect, "first"], timeoutMs: 30000 } },
    { plannerResources: f.resources },
  );
  await expect(
    f.registry.call(
      f.ctx,
      "sp06-rpc",
      "planner.install",
      { intent: { argv: [f.binary, f.effect, "second"], timeoutMs: 30000 } },
      { plannerResources: f.resources },
    ),
  ).rejects.toMatchObject({ code: "capability_denied" });
  expect(await readFile(f.effect, "utf8")).toBe("first");
});
test("same-batch command after a final response has no pending authority or retained intent", async () => {
  const f = await fixture();
  const manifest: PluginManifest = {
    id: "sp06-rpc",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1",
    contributes: { planner: {} },
    capabilities: [{ name: "process.spawn", scopes: ["sp06-tool"] }],
    tier: "free",
    reentrant: false,
  };
  const registry = new PluginRegistry({
    bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({
      argv: [
        process.execPath,
        join(import.meta.dir, "fixtures/sp06-rpc/late.ts"),
      ],
      cwd: f.ctx.home,
      env: {},
    }),
  });
  try {
    await registry.call(
      f.ctx,
      "sp06-rpc",
      "planner.install",
      {
        intent: {
          argv: [f.binary, f.effect, "late"],
          undo: [f.binary, f.effect, "undo"],
          timeoutMs: 30000,
        },
      },
      { plannerResources: f.resources },
    );
    expect(f.resources.commandUndos()).toEqual([]);
    expect(await Bun.file(f.effect).exists()).toBe(false);
  } finally {
    await registry.shutdown();
  }
});
test("one failed retained undo does not prevent attempts of every older admitted undo", async () => {
  const f = await fixture(
    "install",
    "require('node:fs').writeFileSync(process.argv[2],process.argv[3]);if(process.argv[3]==='bad')process.exit(3);",
  );
  const older = join(f.ctx.home, "older");
  await f.registry.call(
    f.ctx,
    "sp06-rpc",
    "planner.install",
    {
      intents: [
        {
          argv: [f.binary, older, "forward"],
          undo: [f.binary, older, "older-undo"],
          timeoutMs: 30000,
        },
        {
          argv: [f.binary, f.effect, "forward"],
          undo: [f.binary, f.effect, "bad"],
          timeoutMs: 30000,
        },
      ],
    },
    { plannerResources: f.resources },
  );
  await expect(f.resources.rollback()).rejects.toMatchObject({
    code: "plugin_unavailable",
  });
  expect(await readFile(older, "utf8")).toBe("older-undo");
  expect(await readFile(f.effect, "utf8")).toBe("bad");
});
test("unique admitted undo work reserves one captured cleanup budget before forward effects", async () => {
  const f = await fixture();
  const now = Date.now(),
    lease = new PlannerResources(f.ctx, {
      purpose: "install",
      binaries: ["sp06-tool"],
      cwd: f.ctx.home,
      deadlineMs: now + 90000,
      operationDeadlineMs: now + 60000,
    });
  try {
    await expect(
      f.registry.call(
        f.ctx,
        "sp06-rpc",
        "planner.install",
        {
          intents: [
            {
              argv: [f.binary, f.effect, "first"],
              undo: [f.binary, f.effect, "undo-first"],
              timeoutMs: 20000,
            },
            {
              argv: [f.binary, f.effect, "second"],
              undo: [f.binary, f.effect, "undo-second"],
              timeoutMs: 20000,
            },
          ],
        },
        { plannerResources: lease },
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(await readFile(f.effect, "utf8")).toBe("first");
    expect(lease.commandUndos()).toEqual([[f.binary, f.effect, "undo-first"]]);
    await lease.rollback();
    expect(await readFile(f.effect, "utf8")).toBe("undo-first");
  } finally {
    await lease.dispose();
  }
});
test("forward execution cannot refresh the captured operation deadline", async () => {
  const f = await fixture(
    "install",
    "await Bun.sleep(3000);require('node:fs').writeFileSync(process.argv[2],process.argv[3]);",
  );
  const now = Date.now(),
    lease = new PlannerResources(f.ctx, {
      purpose: "install",
      binaries: ["sp06-tool"],
      cwd: f.ctx.home,
      deadlineMs: now + 5000,
      operationDeadlineMs: now + 300,
    });
  try {
    await expect(
      f.registry.call(
        f.ctx,
        "sp06-rpc",
        "planner.install",
        { intent: { argv: [f.binary, f.effect, "late"], timeoutMs: 30000 } },
        { plannerResources: lease },
      ),
    ).rejects.toMatchObject({ code: "capability_denied" });
    expect(Date.now() - now).toBeLessThan(1500);
    expect(await Bun.file(f.effect).exists()).toBe(false);
  } finally {
    await lease.dispose();
  }
});
