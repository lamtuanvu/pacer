import { expect, test } from "bun:test";
import { main } from "../src/cli";
import { parseArgs, trimFrame, USAGE } from "../src/dashboard/cli";
import { fakeCtx } from "./helpers";

test("dashboard arguments: plain, once, screen and width; anything else is a usage error", () => {
  expect(parseArgs([])).toEqual({ plain: false, once: false, screen: "home" });
  expect(parseArgs(["--plain"])).toMatchObject({ plain: true });
  expect(parseArgs(["--once", "--screen", "review", "--width", "80"])).toEqual({ plain: false, once: true, screen: "review", width: 80 });
  for (const args of [["--bad"], ["--screen", "review"], ["--once", "--screen", "nope"], ["--once", "--width", "10"], ["extra"]]) expect(parseArgs(args)).toBe(USAGE);
});

test("the dashboard command is advertised and rejects invalid args without touching state", async () => {
  expect((await main(["help"], fakeCtx())).out).toContain("dashboard");
  expect(await main(["dashboard", "--bad"], fakeCtx())).toEqual({ code: 2, out: "", err: USAGE });
});

test("--once prints one plain frame without a terminal, sized to its content", async () => {
  const result = await main(["dashboard", "--once", "--plain", "--width", "100"], fakeCtx());
  expect(result.code).toBe(0);
  expect(result.out).not.toContain("\x1b");
  expect(result.out).toMatch(/^ =\| pacer/);
  expect(result.out).toContain("[ Setup ]");
  expect(result.out.split("\n").length).toBeLessThan(40);
  for (const line of result.out.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
});

test("one-shot frames drop the empty body but keep the footer", () => {
  const frame = ["top", "strip", "rule", "body", "", "", "rule", "message", "keys"].join("\n");
  expect(trimFrame(frame)).toBe(["top", "strip", "rule", "body", "rule", "message", "keys"].join("\n"));
});
