import { expect, test } from "bun:test";
import { createPlannerIO } from "../packages/plugin-sdk/src/install/transport";
import type { HostClient } from "../packages/plugin-sdk/src";

const host = (call: HostClient["call"]) => ({ call }) as HostClient;
test("planner transport refuses an inline image without observed mode", async () => {
  const io = createPlannerIO(
    host(async () => ({ text: "config", mtime: 1 }) as any),
  );
  await expect(io.read("/synthetic/config")).rejects.toThrow("mode");
});
test("planner transport retains missing and host errors without default images", async () => {
  expect(
    await createPlannerIO(host(async () => ({ missing: true }) as any)).read(
      "/synthetic/config",
    ),
  ).toBeNull();
  await expect(
    createPlannerIO(
      host(async () => {
        throw Error("denied");
      }),
    ).read("/synthetic/config"),
  ).rejects.toThrow("denied");
});
test("planner transport checks every range mode and exact length", async () => {
  const info = {
    path: "/synthetic/config",
    size: 262145,
    mtimeMs: 1,
    inode: 1,
    device: 2,
    mode: 0o100700,
  };
  let offset = 0;
  const io = createPlannerIO(
    host(async (method, params: any) => {
      if (method === "capability.fs.read") return { ranged: info } as any;
      expect(params.expected.mode).toBe(info.mode);
      const length = Math.min(262144, info.size - offset);
      offset += length;
      return {
        base64: Buffer.alloc(length, 97).toString("base64"),
        info: { ...info, mode: offset > 262144 ? 0o100600 : info.mode },
      } as any;
    }),
  );
  await expect(io.read(info.path)).rejects.toThrow("changed");
});

test("prior record projection requires exact bytes and strict UTF8", async () => {
  const { readPlannerPrior } = await import(
    "../packages/plugin-sdk/src/install/transport"
  );
  await expect(
    readPlannerPrior(
      host(
        async () => ({ base64: Buffer.from([255]).toString("base64") }) as any,
      ),
      { handle: "bound", bytes: 1 },
    ),
  ).rejects.toThrow();
  await expect(
    readPlannerPrior(
      host(async () => ({ base64: "" }) as any),
      { handle: "bound", bytes: 1 },
    ),
  ).rejects.toThrow();
});
