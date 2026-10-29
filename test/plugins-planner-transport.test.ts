import { expect, test } from "bun:test";
import { join } from "node:path";
import { PluginProcess } from "../src/plugins/process";
import { PlannerResources } from "../src/plugins/planner-resources";
import { createCallAuthority } from "../src/plugins/authority";
import { fakeCtx } from "./helpers";
async function child(features: string[], method: string) {
  const ctx = fakeCtx();
  const authority = createCallAuthority(
    ctx,
    { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 10000 },
  );
  const lease = new PlannerResources(ctx, {
    purpose: method === "planner.uninstall" ? "uninstall" : "install",
    binaries: [],
    cwd: ctx.home,
  });
  lease.bind(authority, method);
  const p = new PluginProcess(
    {
      argv: [
        process.execPath,
        join(import.meta.dir, "fixtures/sp06-rpc/large-result.ts"),
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
    },
    {
      onRequest: async () => {
        throw Error("unexpected capability");
      },
      onStderr: () => {},
      onExit: () => {},
    },
  );
  try {
    const hello = await p.request<any>(
      "plugin.hello",
      {
        protocol: "1.4.0",
        features,
        pacer: "0",
        manifest: {},
        config: {},
        grants: [],
      },
      5000,
    );
    p.setFeatures(hello.features ?? []);
    return await p.request<any>(method, {}, 5000, {
      authority,
      metadata: { capabilityCall: authority.token },
      signal: authority.signal,
    });
  } finally {
    await p.terminate();
    await authority.revoke();
    await lease.dispose();
  }
}
test("actual SDK child streams a multibyte final planner.install result through negotiated staging", async () => {
  expect(
    await child(
      ["chunkedResults", "plannerInstallTransactions"],
      "planner.install",
    ),
  ).toEqual({ schema: 1, text: "界".repeat(380000) });
});
test("planner final-result staging requires both negotiated features", async () => {
  await expect(
    child(["chunkedResults"], "planner.install"),
  ).rejects.toMatchObject({ code: "too_large" });
});
test("preview cannot use planner final-result staging with all transport features", async () => {
  await expect(
    child(["chunkedResults", "plannerInstallTransactions"], "planner.plan"),
  ).rejects.toMatchObject({ code: "too_large" });
});
for (const mode of ["wrong-receipt", "incomplete", "overlap"])
  test(`actual planner result staging rejects ${mode}`, async () => {
    const ctx = fakeCtx(),
      authority = createCallAuthority(
        ctx,
        { reads: [], commands: [], stores: [] },
        { deadlineMs: Date.now() + 5000 },
      );
    const p = new PluginProcess(
      {
        argv: [
          process.execPath,
          join(import.meta.dir, "fixtures/sp06-rpc/chunks.ts"),
        ],
        cwd: ctx.home,
        env: {},
      },
      {
        onRequest: async () => {
          throw Error("unexpected capability");
        },
        onStderr: () => {},
        onExit: () => {},
      },
    );
    const lease = new PlannerResources(ctx, {
      purpose: "install",
      binaries: [],
      cwd: ctx.home,
    });
    lease.bind(authority, "planner.install");
    p.setFeatures(["chunkedResults", "plannerInstallTransactions"]);
    try {
      await expect(
        p.request("planner.install", { mode }, 3000, {
          authority,
          signal: authority.signal,
          metadata: { capabilityCall: authority.token },
        }),
      ).rejects.toMatchObject({
        code: mode === "overlap" ? "conflict" : "invalid_input",
      });
    } finally {
      await p.terminate();
      await authority.revoke();
      await lease.dispose();
    }
  });

test("a forged uninstall method cannot stage under an install-purpose borrow", async () => {
  const ctx = fakeCtx(),
    authority = createCallAuthority(
      ctx,
      { reads: [], commands: [], stores: [] },
      { deadlineMs: Date.now() + 5000 },
    );
  const lease = new PlannerResources(ctx, {
    purpose: "install",
    binaries: [],
    cwd: ctx.home,
  });
  lease.bind(authority, "planner.install");
  const p = new PluginProcess(
    {
      argv: [
        process.execPath,
        join(import.meta.dir, "fixtures/sp06-rpc/chunks.ts"),
      ],
      cwd: ctx.home,
      env: {},
    },
    {
      onRequest: async () => {
        throw Error("unexpected capability");
      },
      onStderr: () => {},
      onExit: () => {},
    },
  );
  p.setFeatures(["chunkedResults", "plannerInstallTransactions"]);
  try {
    await expect(
      p.request("planner.uninstall", { mode: "wrong-receipt" }, 3000, {
        authority,
        signal: authority.signal,
        metadata: { capabilityCall: authority.token },
      }),
    ).rejects.toMatchObject({ code: "capability_denied" });
  } finally {
    await p.terminate();
    await authority.revoke();
    await lease.dispose();
  }
});
