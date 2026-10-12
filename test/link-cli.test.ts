import { expect, test } from "bun:test";
import { linkCli } from "../src/link/cli";
import { readLatest } from "../src/link/store";
import { fakeCtx } from "./helpers";
import { fakeRun, raw } from "./fixtures/orca/fake";

test("link probe publishes probe alert and reports outbox", async () => {
  const f = fakeRun([[ ["orca", "agent-context"], raw('{"commands":[]}') ]]), ctx = fakeCtx({ run: f.run });
  const r = await linkCli(["probe"], ctx);
  expect(r.code).toBe(0); expect(r.out).toContain("outbox");
  expect(readLatest(ctx).alerts[0]).toEqual({ key: "probe", level: "info", title: "pacer link probe", body: `sent at ${new Date(ctx.now * 1000).toISOString()}`, at: ctx.now });
});
test("link status with nothing running reports absent transports", async () => {
  const f = fakeRun([[ ["orca", "agent-context"], raw('{"commands":[]}') ]]);
  const r = await linkCli(["status"], fakeCtx({ run: f.run }));
  expect(r.code).toBe(0);
  for (const text of ["outbox:", "serve: not reachable", "console: not running", "bridge: plugin not installed", "channel: not available"]) expect(r.out).toContain(text);
});
test("unknown link subcommand returns usage", async () => {
  const r = await linkCli(["bogus"], fakeCtx()); expect(r.code).toBe(2); expect(r.err).toContain("link status|probe");
});
