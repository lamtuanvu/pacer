import { expect, test } from "bun:test";
import { createDesktopAdapter } from "../scripts/live/control/desktop";
import type { Session } from "../scripts/live/core";
test("native adapter refuses an unowned desktop and reused process identity", async () => {
  await expect(createDesktopAdapter({} as Session)).rejects.toThrow("target_unavailable");
  const adapter = await createDesktopAdapter({ desktopPid: process.pid, desktopIdentity: { pid: process.pid, start_identity: "old" } } as Session);
  await expect(adapter.targets()).rejects.toThrow("stale_reference");
});
