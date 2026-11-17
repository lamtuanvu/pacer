import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderedScreen, retryBanner, retryBannerHint } from "../src/exec/limits";
import { Recording } from "../src/session/recording";
import { Screen } from "../src/session/screen";
import { tmpDir } from "./helpers";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name));
async function rendered(name: string): Promise<string> {
  const screen = new Screen();
  try { await screen.output(fixture(name)); return screen.plain(); } finally { screen.dispose(); }
}

test("renders the 524 banner as transient", async () => {
  expect(retryBanner("opencode", await rendered("opencode-retry-524.ansi")))
    .toEqual({ kind: "transient", attempt: 3, delayS: 120, reason: expect.stringContaining("HTTP 524") });
});

test("renders the rate-limit banner as limit", async () => {
  expect(retryBanner("opencode", await rendered("opencode-retry-ratelimit.ansi")))
    .toEqual({ kind: "limit", attempt: 6, delayS: 900, reason: expect.stringContaining("Rate limit exceeded") });
});

test("banner in source text is ignored", async () => {
  const text = await rendered("opencode-working-source.ansi");
  expect(text).toContain("Retrying in 120s · attempt 3");
  expect(retryBanner("opencode", text)).toBeNull();
});

test("other agents have no banner", async () => {
  expect(retryBanner("cursor", await rendered("opencode-retry-524.ansi"))).toBeNull();
});

test("the raw prefilter matches garbled TUI output", () => {
  expect(retryBannerHint("opencode", "in120s · attempt 3 · Providr requestfailed")).toBe(true);
  expect(retryBannerHint("opencode", "no banner here")).toBe(false);
  expect(retryBannerHint("cursor", "in120s · attempt 3 · Providr requestfailed")).toBe(false);
});

test("named runners and unknown reasons", () => {
  expect(retryBanner("opencode#work", "     ⚠ Retrying in 5s · attempt 1 · socket hang up")).toEqual({ kind: "transient", attempt: 1, delayS: 5, reason: "socket hang up" });
  expect(retryBanner("opencode", "     ⚠ Retrying in 30s · attempt 2 · Service unavailable: rate limit")?.kind).toBe("transient");
});

test("renderedScreen replays the run's recording", async () => {
  const dir = tmpDir();
  expect(await renderedScreen(dir)).toBe("");
  const recording = new Recording(dir);
  await recording.output(fixture("opencode-retry-ratelimit.ansi"));
  await recording.close();
  const text = await renderedScreen(dir);
  expect(text.split("\n").length).toBeLessThanOrEqual(60);
  expect(retryBanner("opencode", text)).toMatchObject({ kind: "limit", attempt: 6, delayS: 900 });
});
