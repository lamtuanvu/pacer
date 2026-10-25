import { expect, test } from "bun:test";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

test("dispatch CLI requires explicit repo and goal and validates flags", async () => {
  expect((await main(["dispatch", "preview"], fakeCtx())).code).toBe(2);
  expect((await main(["dispatch", "preview", "--repo", "x", "--goal", "g", "--unknown"], fakeCtx())).code).toBe(2);
  expect((await main(["--help"], fakeCtx())).out).toContain("dispatch");
});
