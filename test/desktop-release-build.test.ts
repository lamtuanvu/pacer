import { expect, test } from "bun:test";
import { compileCommand, buildRelease } from "../scripts/release/build";
import { TARGETS } from "../src/update/manifest";
import { tmpDir } from "./helpers";

const target = TARGETS.find(t => t.os === "darwin" && t.arch === "arm64")!;
const input = { root: "/fixture", target, version: "1.2.3", outfile: "/fixture/pacer", bunExe: "/fixture/bun" };
test("desktop CLI trust is explicit and ordinary compile arguments retain no trust define", () => {
  const normal = compileCommand(input);
  expect(normal).toContain('PACER_BUILD_VERSION="1.2.3"');
  expect(normal.join(" ")).not.toContain("PACER_BUILD_APPLE_TEAM_ID");
  const desktop = compileCommand({ ...input, desktopTrust: { appleTeamId: "ABCDE12345" } });
  expect(desktop).toContain('PACER_BUILD_APPLE_TEAM_ID="ABCDE12345"');
  expect(desktop.filter(x => x !== "--define" && x !== 'PACER_BUILD_APPLE_TEAM_ID="ABCDE12345"')).toEqual(normal.filter(x => x !== "--define"));
});
test("malformed or non-macOS desktop trust is refused before compiling or removing output", async () => {
  for (const appleTeamId of ["", "short", "ABCDE12345;echo x", "abcde12345"]) {
    expect(() => compileCommand({ ...input, desktopTrust: { appleTeamId } })).toThrow("Team ID");
    await expect(buildRelease({ root: tmpDir(), outRoot: tmpDir(), version: "1.2.3", targets: [], desktopTrust: { appleTeamId } })).rejects.toThrow("Team ID");
  }
  expect(() => compileCommand({ ...input, target: TARGETS.find(t => t.os === "linux")!, desktopTrust: { appleTeamId: "ABCDE12345" } })).toThrow("macOS");
});
