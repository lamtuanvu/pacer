import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { fixtureFeedDryRun } from "../scripts/release/desktop-feed-fixture";
test("explicit fixture driver uses real pinned signer and local immutable assets without leaving private keys", async () => {
  const root = join(tmpDir(), "fixture");
  const report = await fixtureFeedDryRun(root);
  expect(report.mode).toBe("fixture");
  expect(report.production).toBe("UNVERIFIED");
  expect(report.native).toBe("UNVERIFIED");
  expect(report.signatures).toBe(2);
  expect(existsSync(join(root, "private"))).toBe(false);
  const feed = JSON.parse(readFileSync(join(root, "stable.json"), "utf8"));
  expect(Object.keys(feed.platforms)).toHaveLength(2);
  expect(existsSync(join(root, "local/feed.git"))).toBe(true);
  await expect(fixtureFeedDryRun(root)).rejects.toThrow();
}, 30000);
