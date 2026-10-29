import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

// Run actual production selection/traversal with a deterministic AX read provider.
// Removing role/PID/geometry checks or using CFHash for equality breaks these cases.
test.skipIf(process.platform !== "darwin")("native observer binds an owned window and bounds cyclic AX graphs", async () => {
  const source = readFileSync(join(import.meta.dir, "../scripts/live/native/main.swift"), "utf8");
  const functions = source.slice(source.indexOf("func axPID("), source.indexOf("func keyCode("));
  const delivery = source.slice(source.indexOf("struct NativeFailure"), source.indexOf("func verifyProcess("));
  const fixture = readFileSync(join(import.meta.dir, "fixtures/native-observer/fixture.swift"), "utf8");
  const directory = tmpDir(), swift = join(directory, "main.swift"), executable = join(directory, "observer-policy");
  writeFileSync(swift, fixture.replace("// PRODUCTION_FUNCTIONS", delivery + functions));
  const build = Bun.spawn(["/usr/bin/swiftc", swift, "-o", executable], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(build.stderr).text();
  expect({ code: await build.exited, error }).toEqual({ code: 0, error: "" });
  const run = Bun.spawn([executable], { stdout: "pipe", stderr: "pipe" });
  const checks = JSON.parse(await new Response(run.stdout).text());
  expect(await run.exited).toBe(0);
  expect(checks).toEqual({
    ownedUnique: true, applicationRejected: true, wrongPIDRejected: true, wrongTitleRejected: true,
    wrongGeometryRejected: true, missingGeometryRejected: true, ambiguousRejected: true,
    invalidMemberRejected: true, unreadablePIDRejected: true, roundedGeometryAccepted: true, outsideToleranceRejected: true,
    nonfiniteGeometryRejected: true, wrongPositionTypeRejected: true, wrongSizeTypeRejected: true,
    wrongAXValueKindRejected: true,
    sameTitleOtherGeometryIgnored: true, selfCycleBounded: true, mutualCycleBounded: true,
    hashCollisionRetained: true, aliasesDeduplicated: true,
    "delivery-not_delivered": true, "delivery-unknown": true, partialActivationUnknown: true,
  });
}, 30000);
