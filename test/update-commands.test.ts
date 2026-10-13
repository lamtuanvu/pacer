import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

const PKG_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;

test("pacer --version and pacer version print the version", async () => {
  const ctx = fakeCtx();
  expect(await main(["--version"], ctx)).toEqual({ code: 0, out: `pacer ${PKG_VERSION}`, err: "" });
  expect(await main(["version"], ctx)).toEqual({ code: 0, out: `pacer ${PKG_VERSION}`, err: "" });
});

test("version needs no strategy file and help lists it", async () => {
  const ctx = fakeCtx();
  expect((await main(["version"], ctx)).code).toBe(0);
  expect((await main(["help"], ctx)).out).toContain("print the pacer version");
});

test("help explains refresh and shared skill directories", async () => {
  const out = (await main(["help"], fakeCtx())).out;
  expect(out).toContain("--no-reinstall");
  expect(out).toContain("update refreshes installed skills, policy and hooks");
  expect(out).toContain("Cursor and OpenCode also read ~/.claude/skills");
  expect(out).toContain("Cursor also reads ~/.codex/skills");
});
