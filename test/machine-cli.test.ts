import { beforeEach, expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { main } from "../src/cli";
import { machineCommand } from "../src/commands/machine";
import { clearIdentityCache, setIdentityPlatformForTests } from "../src/identity/store";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });
function setup() { const ctx = fakeCtx(); ctx.env.PACER_API = "inprocess"; return ctx; }

test("show prints the name and id; rename changes the name", async () => {
  const ctx = setup();
  const shown = await machineCommand.run(["show", "--json"], ctx);
  expect(shown.code).toBe(0);
  const view = JSON.parse(shown.out);
  const renamed = await machineCommand.run(["rename", "studio-mac", "--json"], ctx);
  expect(JSON.parse(renamed.out)).toMatchObject({ id: view.id, name: "studio-mac", rev: view.rev + 1 });
  const text = await main(["machine", "show"], ctx);
  expect(text.code).toBe(0);
  expect(text.out).toContain("studio-mac");
  expect(text.out).toContain(view.id);
});

test("rotate refuses without --yes and replaces the id with it", async () => {
  const ctx = setup();
  const r = await machineCommand.run(["rotate"], ctx);
  expect(r.code).toBe(2);
  expect(r.err).toContain("--yes");
  const before = JSON.parse((await machineCommand.run(["show", "--json"], ctx)).out);
  const rotated = JSON.parse((await machineCommand.run(["rotate", "--yes", "--json"], ctx)).out);
  expect(rotated).toEqual({ oldId: before.id, newId: expect.any(String) });
  expect(rotated.newId).not.toBe(before.id);
});

test("unknown subcommands print usage", async () => {
  const r = await machineCommand.run(["bogus"], setup());
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage");
});

test("an executor session may show but not rename or rotate the machine (S1)", async () => {
  // With a work grant, dashboardClient still talks to the service with the owner bearer, so the CLI applies the caller policy.
  const { machineCmd } = await import("../src/commands/machine");
  const calls: string[] = [];
  const client = { call: async (op: string) => { calls.push(op); return { id: "m1", name: "box", rev: 1, cloneSuspected: false }; }, close() {} } as any;
  const ctx = fakeCtx({ env: { PACER_ROLE: "executor" } });
  expect((await machineCmd(["show"], ctx, async () => client)).code).toBe(0);
  for (const args of [["rename", "evil"], ["rotate", "--yes"]]) {
    const r = await machineCmd(args, ctx, async () => client);
    expect(r.code).toBe(2);
    expect(r.err).toContain("PACER_ROLE=executor");
  }
  expect(calls).toEqual(["machine.get"]);
});
