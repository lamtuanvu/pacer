import { expect, test } from "bun:test";
import { join } from "node:path";
import { CallAdmission } from "../src/plugins/admission";
import { createCallAuthority } from "../src/plugins/authority";
import { PluginProcess } from "../src/plugins/process";
import { CoreError } from "../src/core/errors";
import { fakeCtx } from "./helpers";

const empty = { reads: [], commands: [], stores: [] };
const busyUntil = (at: number) => { while (Date.now() < at) { /* A loaded event loop runs past the deadline. */ } };

test("an owner deadline seen by a provider poll before any timer still ends the call as a timeout", async () => {
  const ctx = fakeCtx();
  const peer = new PluginProcess({ argv: [process.execPath, join(import.meta.dir, "fixtures/sp02-rpc/peer.ts")], cwd: ctx.home, env: {} },
    { onRequest: async () => ({}), onStderr: () => {}, onExit: () => {} });
  try {
    const deadlineAt = Date.now() + 50;
    const call = new CallAdmission().run(deadlineAt, async signal => {
      const authority = createCallAuthority(ctx, empty, { deadlineMs: deadlineAt, signal });
      try {
        const request = peer.request("diagnostic.ping", { hang: true }, deadlineAt - Date.now(),
          { signal: authority.signal, authority });
        busyUntil(deadlineAt);
        // The provider's next executor poll is answered before the admission's deadline timer runs.
        expect(() => authority.assertActive()).toThrow();
        return await request;
      } finally { await authority.revoke(); }
    });
    await expect(call).rejects.toMatchObject({ code: "plugin_timeout" });
  } finally { await peer.terminate(); }
});

test("a call that fails only because its owner expired cannot win over a delayed timer callback", async () => {
  const pending = new CallAdmission().run(Date.now() + 2, async () => {
    busyUntil(Date.now() + 8);
    throw new CoreError("plugin_unavailable", "owning plugin call ended");
  });
  await expect(pending).rejects.toMatchObject({ code: "plugin_timeout" });
});

test("a failure before the absolute deadline keeps its own reason", async () => {
  const pending = new CallAdmission().run(Date.now() + 10_000, async () => {
    throw new CoreError("plugin_unavailable", "owning plugin call ended");
  });
  await expect(pending).rejects.toMatchObject({ code: "plugin_unavailable", message: "owning plugin call ended" });
});
