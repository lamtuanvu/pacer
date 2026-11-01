import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exercisePublicationHome } from "../scripts/live/publication";
import { tmpDir } from "./helpers";

test("fixed live publication fixture exercises all three Unicode boundaries in a private home", async () => {
  const home = join(tmpDir(), "publication-fixture");
  await exercisePublicationHome(home);
  expect(existsSync(join(home, "link/latest.json"))).toBe(true);
  expect(readFileSync(join(home, "endpoints/state.json"), "utf8")).toContain("not_working");
  await expect(exercisePublicationHome(home)).rejects.toThrow();
});
