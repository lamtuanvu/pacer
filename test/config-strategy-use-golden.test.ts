import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { goldenPath, recordStrategyUse } from "../scripts/golden/strategy-use";

test("strategy.use TypeScript state and event goldens remain fresh", async () => {
  expect(await recordStrategyUse()).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
});

test("strategy.use retains the active switch and alert if activity append fails", async () => {
  const caseData = JSON.parse(readFileSync(goldenPath, "utf8"))[0];
  const home = mkdtempSync(join(tmpdir(), "pacer-use-partial-"));
  try {
    const pacerHome = join(home, ".pacer");
    mkdirSync(join(pacerHome, "strategies"), { recursive: true });
    mkdirSync(join(pacerHome, "state/activity.jsonl"), { recursive: true });
    writeFileSync(join(pacerHome, "strategy.yaml"), caseData.defaultYaml);
    writeFileSync(join(pacerHome, "strategies/research.yaml"), caseData.researchYaml);
    const ctx = fakeCtx({ home, pacerHome, now: 1_700_000_000 });
    await expect(callOp(ctx, "strategy.use", { name: "research" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(readFileSync(join(pacerHome, "active"), "utf8")).toBe("research\n");
    const outbox = readFileSync(join(pacerHome, "link/outbox.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(outbox.map(row => row.envelope.type)).toEqual(["alert"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
