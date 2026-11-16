import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "./temp-roots";
import {
  clearSetupHealthRequired,
  markSetupHealthRequired,
  readSetupHealthPass,
  setupHealthRequired,
  writeSetupHealthPass,
} from "../src/install/setup-health-store";
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
    const root = createTestRoot("pacer-test-");
    mkdirSync(join(root, ".pacer"), { mode: 0o700 });
    const ctx = { pacerHome: join(root, ".pacer") };
    writeSetupHealthPass(ctx, {
      fingerprint: fingerprint(),
      trigger: "startup",
      outcome: "ok",
      durationSeconds: 1.5,
    });
    const path = join(ctx.pacerHome, "setup-health.json");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readSetupHealthPass(ctx)).toEqual({
      schema: 1,
      fingerprint: fingerprint(),
      trigger: "startup",
      outcome: "ok",
      durationSeconds: 1.5,
    });
  });

  test("returns null for missing or malformed records", () => {
    const root = createTestRoot("pacer-test-");
    mkdirSync(join(root, ".pacer"), { mode: 0o700 });
    const ctx = { pacerHome: join(root, ".pacer") };
    expect(readSetupHealthPass(ctx)).toBeNull();
    writeSetupHealthPass(ctx, {
      fingerprint: fingerprint(),
      trigger: "manual",
      outcome: "warnings",
    });
    writeFileSync(join(ctx.pacerHome, "setup-health.json"), "{not-json", { mode: 0o600 });
    expect(readSetupHealthPass(ctx)).toBeNull();
  });

  test("marks and clears a post-update required stamp", () => {
    const root = createTestRoot("pacer-test-");
    mkdirSync(join(root, ".pacer"), { mode: 0o700 });
    const ctx = { pacerHome: join(root, ".pacer") };
    expect(setupHealthRequired(ctx)).toBe(false);
    markSetupHealthRequired(ctx);
    expect(setupHealthRequired(ctx)).toBe(true);
    clearSetupHealthRequired(ctx);
    expect(setupHealthRequired(ctx)).toBe(false);
  });
});
