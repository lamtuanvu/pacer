import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp, opNames } from "../src/api/ops";
import { V3_ONLY_OPS } from "../src/api/v2-compat";
import { markSetupHealthRequired, readSetupHealthPass, writeSetupHealthPass } from "../src/install/setup-health-store";
import { currentVersion } from "../src/update/version";
import type { SetupHealthFingerprint } from "../src/view-model/setup-health";
import { fakeCtx } from "./helpers";

function strategy(ctx: { pacerHome: string }) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {usage: quota}\nrouting:\n  - default: [claude-code]\n",
  );
}

function cleanFingerprint(hashes: Record<string, string> = {}): SetupHealthFingerprint {
  return {
    schema: 1,
    appVersion: currentVersion(),
    serviceVersion: currentVersion(),
    integrationHashes: hashes,
    attentionCount: 0,
    checkedAt: 1,
    stepVerdicts: {
      service: "passed",
      detect_agents: "passed",
      integrations: "passed",
      usage_eligibility: "passed",
      ready: "passed",
    },
  };
}

test("setup.health is additive and v3-only", () => {
  expect(opNames()).toContain("setup.health");
  expect(V3_ONLY_OPS.has("setup.health")).toBe(true);
});

test("setup.health returns ordered steps, excludes removable-volume gate checks, and records last-pass", async () => {
  const ctx = fakeCtx({ which: () => null });
  strategy(ctx);
  mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
  writeFileSync(
    join(ctx.pacerHome, "state", "repos.json"),
    JSON.stringify({ ["/Volumes/Offline/repo"]: { path: "/Volumes/Offline/repo", key: "local:test", lastUsed: ctx.now } }),
  );

  const result = await callOp(ctx, "setup.health", { trigger: "startup" }) as {
    title: string;
    steps: { id: string; state: string }[];
    fingerprint: SetupHealthFingerprint;
    skipFullWindow: boolean;
    checkedAt: number;
  };

  expect(result.title).toBe("Checking setup");
  expect(result.checkedAt).toBe(ctx.now);
  expect(result.steps.map(s => s.id)).toEqual([
    "service",
    "detect_agents",
    "integrations",
    "usage_eligibility",
    "ready",
  ]);
  expect(result.steps.every(s => typeof s.state === "string")).toBe(true);
  expect(result.skipFullWindow).toBe(false);

  const pass = readSetupHealthPass(ctx);
  expect(pass).not.toBeNull();
  expect(pass!.fingerprint).toEqual(result.fingerprint);
  expect(pass!.trigger).toBe("startup");

  // Removable-volume probes may still run inside doctor, but must not appear as gate step details flood.
  const doctor = await callOp(ctx, "doctor.run", {}) as { checks: { name: string }[] };
  const removable = doctor.checks.filter(c => c.name.startsWith("Removable volume "));
  // Doctor probes removable volumes only on macOS.
  if (process.platform === "darwin") expect(removable.length).toBeGreaterThan(0);
  expect(JSON.stringify(result.steps)).not.toContain("Removable volume");
});

test("setup.health skipFullWindow requires a matching previous pass and zero attention", async () => {
  const ctx = fakeCtx({ which: () => null });
  strategy(ctx);

  const first = await callOp(ctx, "setup.health", {}) as {
    fingerprint: SetupHealthFingerprint;
    skipFullWindow: boolean;
    attentionCount: number;
  };
  expect(first.skipFullWindow).toBe(false);

  writeSetupHealthPass(ctx, {
    fingerprint: {
      ...first.fingerprint,
      attentionCount: 0,
      stepVerdicts: cleanFingerprint().stepVerdicts,
    },
    trigger: "startup",
    outcome: "ok",
  });

  const second = await callOp(ctx, "setup.health", { trigger: "startup" }) as {
    skipFullWindow: boolean;
    attentionCount: number;
  };
  if (second.attentionCount === 0) expect(second.skipFullWindow).toBe(true);
  else expect(second.skipFullWindow).toBe(false);

  const forced = await callOp(ctx, "setup.health", { trigger: "update" }) as {
    skipFullWindow: boolean;
    trigger: string;
    eyebrow?: string;
  };
  expect(forced.skipFullWindow).toBe(false);
  expect(forced.trigger).toBe("update");
  expect(forced.eyebrow).toBe("After update · checking setup");
});

test("setup.health respects a post-update required stamp without an explicit update trigger", async () => {
  const ctx = fakeCtx({ which: () => null });
  strategy(ctx);
  markSetupHealthRequired(ctx);
  const result = await callOp(ctx, "setup.health", { trigger: "startup" }) as {
    skipFullWindow: boolean;
    trigger: string;
    eyebrow?: string;
  };
  expect(result.skipFullWindow).toBe(false);
  expect(result.trigger).toBe("update");
  expect(result.eyebrow).toBe("After update · checking setup");
});
