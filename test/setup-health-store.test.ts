import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "./temp-roots";
import { readSetupHealthPass, writeSetupHealthPass, type SetupHealthPassRecord } from "../src/install/setup-health-store";
import type { SetupHealthFingerprint } from "../src/view-model/setup-health";

const fingerprint = (): SetupHealthFingerprint => ({
  schema: 1,
  appVersion: "0.14.0",
  serviceVersion: "0.14.0",
  integrationHashes: { cursor: "abc" },
  attentionCount: 0,
  checkedAt: 100,
  stepVerdicts: {
    service: "passed",
    detect_agents: "passed",
    integrations: "passed",
    usage_eligibility: "passed",
    ready: "passed",
  },
});

describe("setup-health-store", () => {
  test("round-trips a last-pass record at 0600", () => {
    const root = createTestRoot("setup-health-store");
    mkdirSync(join(root, ".pacer"), { mode: 0o700 });
    const ctx = { pacerHome: join(root, ".pacer") };
    const record: SetupHealthPassRecord = {
      schema: 1,
      fingerprint: fingerprint(),
      trigger: "startup",
      outcome: "ok",
      durationSeconds: 1.5,
    };
    writeSetupHealthPass(ctx, record);
    const path = join(ctx.pacerHome, "setup-health.json");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readSetupHealthPass(ctx)).toEqual(record);
  });

  test("returns null for missing or malformed records", () => {
    const root = createTestRoot("setup-health-store-missing");
    mkdirSync(join(root, ".pacer"), { mode: 0o700 });
    const ctx = { pacerHome: join(root, ".pacer") };
    expect(readSetupHealthPass(ctx)).toBeNull();
    writeSetupHealthPass(ctx, {
      schema: 1,
      fingerprint: fingerprint(),
      trigger: "manual",
      outcome: "warnings",
    });
    writeFileSync(join(ctx.pacerHome, "setup-health.json"), "{not-json", { mode: 0o600 });
    expect(readSetupHealthPass(ctx)).toBeNull();
  });
});
