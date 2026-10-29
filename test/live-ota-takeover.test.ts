import { expect, test } from "bun:test";
import { readyControl } from "../scripts/live/ota-takeover";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertFixtureLayoutScenario, initialFixtureVersion } from "../scripts/live/ota";
import { TAKEOVER_SCENARIOS } from "../scripts/live/ota-exercise-record";

const button = (disabled?: boolean) => ({ ref: "e1", role: "button", name: "Use the app's service", actions: ["click"], disabled });

test("the driver clicks a control only once it is enabled, so the confirm hold is waited out", () => {
  // aria-disabled during the hold reaches the inspector as a disabled control.
  expect(readyControl([button(true)], "Use the app's service")).toBeNull();
  expect(readyControl([button(false)], "Use the app's service")?.ref).toBe("e1");
  expect(readyControl([button()], "Use the app's service")?.ref).toBe("e1");
  // Headings and text with the same name are never clicked.
  expect(readyControl([{ ...button(), role: "heading" }, { ...button(), role: "static text" }], "Use the app's service")).toBeNull();
  expect(readyControl([button()], "Not now")).toBeNull();
});

test("native fixture drivers run beside the installed app and prove it untouched", () => {
  for (const file of ["ota-takeover.ts", "ota-exercise.ts"]) {
    const source = readFileSync(join(import.meta.dir, "../scripts/live", file), "utf8");
    expect(source).not.toContain("real desktop is running");
    expect(source).toContain("snapshotRealApp(enumerateNativeProcesses())");
    expect(source).toContain("assertRealAppUnchanged(realApp, snapshotRealApp(enumerateNativeProcesses()))");
  }
});

test("takeover scenarios require the candidate desktop and helper layout", () => {
  const candidate = { initialLayout: "paired" as const, nativeFixture: { baselineVersion: "0.2.3", candidateVersion: "0.2.4" } as any };
  expect(initialFixtureVersion(candidate)).toBe("0.2.4");
  for (const scenario of TAKEOVER_SCENARIOS) {
    expect(() => assertFixtureLayoutScenario(candidate, scenario)).not.toThrow();
    expect(() => assertFixtureLayoutScenario({ initialLayout: "bridge" }, scenario)).toThrow("candidate desktop");
  }
  expect(() => assertFixtureLayoutScenario(candidate, "upgrade")).toThrow();
});

test("native takeover inspector stops accessibility parent-child cycles before descending", () => {
  const source = readFileSync(join(import.meta.dir, "../scripts/live/native/main.swift"), "utf8");
  const tree = source.slice(source.indexOf("func inspectTree("), source.indexOf("func keyCode("));
  expect(tree).toContain("lineage.contains(where: { CFEqual($0, node) })");
  expect(tree.indexOf("lineage.contains(where: { CFEqual($0, node) })")).toBeLessThan(tree.indexOf("elements.append(item)"));
  expect(tree).toContain("lineage + [node]");
});
