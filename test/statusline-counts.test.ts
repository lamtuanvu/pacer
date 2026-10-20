import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { main } from "../src/cli";
import { ensureToken } from "../src/serve/http";
import { writeFileSync, mkdirSync } from "node:fs";
import fixture from "./fixtures/ui/snapshot.json";
import { lineFields } from "../src/render/line";
import type { ClientSnapshot } from "../src/view-model/snapshot";
const snap = () => structuredClone(fixture) as ClientSnapshot;
function local(ctx: ReturnType<typeof fakeCtx>, value: unknown) {
  mkdirSync(join(ctx.pacerHome, "link"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "link/latest.json"), JSON.stringify(value));
}
test("status --line reads v2 counts with authentication and never recomputes usage", async () => {
  const ctx = fakeCtx(), token = ensureToken(ctx); // No strategy required.
  const request = spyOn(globalThis, "fetch").mockImplementation((async (input, options) => {
    expect(String(input)).toEndWith("/v2/snapshot");
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`);
    return Response.json({ snapshot: snap() });
  }) as typeof fetch);
  try {
    expect(await main(["status", "--line", "--no-color"], ctx)).toEqual({ code: 0, out: "▬┃ Claude Code 63%·77  ▸2  ⚑4", err: "" });
    for (const flags of [["--line", "--json"], ["--json", "--line"]]) {
      const r = await main(["status", ...flags], ctx);
      expect(r.code).toBe(0); expect(JSON.parse(r.out)).toEqual(lineFields(snap()));
    }
  } finally { request.mockRestore(); }
});
test("fresh local snapshot keeps shared counts and honors COLUMNS, --width and NO_COLOR", async () => {
  const ctx = fakeCtx(); ctx.env.PACER_PORT = "1"; ctx.env.COLUMNS = "20"; ctx.env.NO_COLOR = "1";
  local(ctx, { ...snap(), at: ctx.now });
  expect((await main(["status", "--line"], ctx)).out).toBe("▬┃63 ⚑4");
  expect((await main(["status", "--line", "--width", "120"], ctx)).out).toBe("▬┃ Claude Code 63%·77  ▸2  ⚑4");
  ctx.env.COLUMNS = "invalid";
  expect((await main(["status", "--line"], ctx)).out).toBe("▬┃ Claude Code 63%·77  ▸2  ⚑4");
});
test("missing, stale, empty and malformed snapshots are offline, including JSON", async () => {
  const ctx = fakeCtx(); ctx.env.PACER_PORT = "1";
  for (const value of [null, { ...snap(), at: ctx.now - 121 }, { at: ctx.now }, { at: ctx.now, planner: {} }]) {
    local(ctx, value);
    const r = await main(["status", "--line"], ctx);
    expect(r).toEqual({ code: 0, out: expect.stringMatching(/▬┃(\x1b\[0m)? pacer not running · pacer serve$/), err: "" });
    expect(JSON.parse((await main(["status", "--line", "--json"], ctx)).out)).toEqual(lineFields(null));
  }
});
test("--line never returns nonzero for invalid arguments", async () => {
  const ctx = fakeCtx();
  for (const flags of [["--wat"], ["--width", "bad"], ["--hook"], ["--width"], ["--width", "--line"]]) {
    expect((await main(["status", "--line", ...flags], ctx)).code).toBe(0);
  }
});
