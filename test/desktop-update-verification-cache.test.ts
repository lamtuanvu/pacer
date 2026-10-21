import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity, VerifiedOnce } from "../src/update/desktop/verification-cache";

test("file identity changes whenever the verified bytes could have changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-identity-")), file = join(dir, "pacer");
  writeFileSync(file, "one");
  const first = fileIdentity(file);
  expect(fileIdentity(file)).toBe(first);
  await Bun.sleep(5);
  writeFileSync(file, "two");
  expect(fileIdentity(file)).not.toBe(first);
  const replacement = join(dir, "next");
  writeFileSync(replacement, "two");
  const rewritten = fileIdentity(file);
  renameSync(replacement, file);
  expect(fileIdentity(file)).not.toBe(rewritten);
});

test("verified-once cache is bounded and forgets everything when full", () => {
  const cache = new VerifiedOnce(2);
  cache.add("a"); cache.add("b");
  expect(cache.has("a") && cache.has("b")).toBe(true);
  cache.add("c");
  expect([cache.has("a"), cache.has("b"), cache.has("c")]).toEqual([false, false, true]);
});
