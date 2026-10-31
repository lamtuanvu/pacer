import { expect, test } from "bun:test";
import { realpathSync, symlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { assertPacerHomeAllowed } from "../src/ctx";
import { liveTestCheckout } from "./live-checkout";
import { tmpDir } from "./helpers";

test("relocating live fixtures preserves the real-home guard, including descendant aliases", async () => {
  const root = liveTestCheckout();
  const { liveRoot } = await import(`${root}/scripts/live/core.ts`) as typeof import("../scripts/live/core");
  expect(liveRoot).toBe(join(realpathSync(root), ".work/live"));
  expect(() => assertPacerHomeAllowed(join(liveRoot, "fixture/home"))).not.toThrow();

  // Check forbidden paths without creating or changing anything in the real home.
  const realHome = join(userInfo().homedir, ".pacer");
  expect(() => assertPacerHomeAllowed(realHome)).toThrow("refuses real user PACER_HOME");
  expect(() => assertPacerHomeAllowed(join(realHome, "worktrees/fixture/.work/live/home"))).toThrow("refuses real user PACER_HOME");
  const alias = join(tmpDir(), "real-home-alias");
  symlinkSync(userInfo().homedir, alias);
  expect(() => assertPacerHomeAllowed(join(alias, ".pacer/worktrees/fixture/home"))).toThrow("refuses real user PACER_HOME");
});
