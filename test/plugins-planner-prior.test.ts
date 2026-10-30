import { expect, test } from "bun:test";
import { PlannerResources } from "../src/plugins/planner-resources";
import { createCallAuthority } from "../src/plugins/authority";
import { fakeCtx } from "./helpers";
test("prior record projection is immutable, exact and retires with owning peer", async () => {
  const ctx = fakeCtx(),
    lease = new PlannerResources(ctx, {
      purpose: "install",
      binaries: [],
      cwd: ctx.home,
    });
  const peer = createCallAuthority(
    ctx,
    { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 30000, grants: ["fs.read"] },
  );
  try {
    lease.bind(peer, "planner.install");
    const input: any = {
      prior: { planner: "bound", notes: ["界".repeat(400000)] },
    };
    const prepared: any = lease.prepareInput(
      input,
      (value) => Buffer.byteLength(JSON.stringify(value)) <= 1048576,
    );
    input.prior.notes[0] = "mutated";
    expect(prepared.prior).toBeUndefined();
    expect(prepared.priorRange.bytes).toBeGreaterThan(1048576);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < prepared.priorRange.bytes; offset += 262144) {
      const reply = await lease.readPrior(peer, {
        handle: prepared.priorRange.handle,
        offset,
        length: Math.min(262144, prepared.priorRange.bytes - offset),
      });
      parts.push(Buffer.from(reply.base64, "base64"));
    }
    expect(JSON.parse(Buffer.concat(parts).toString("utf8")).notes[0]).toBe(
      "界".repeat(400000),
    );
    await peer.revoke();
    await expect(
      lease.readPrior(peer, {
        handle: prepared.priorRange.handle,
        offset: 0,
        length: 1,
      }),
    ).rejects.toMatchObject({ code: "capability_denied" });
  } finally {
    await peer.revoke();
    await lease.dispose();
  }
});
