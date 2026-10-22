import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { tmpDir } from "./helpers";

test("production paired release forwards the same explicit trust to both compiler processes", async () => {
  const root = tmpDir(), script = join(root, "orchestration.ts");
  const build = pathToFileURL(join(import.meta.dir, "../scripts/release/build.ts")).href;
  const signing = pathToFileURL(join(import.meta.dir, "../src/update/signing.ts")).href;
  writeFileSync(script, `
import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
mock.module(${JSON.stringify(signing)}, () => ({ signLocal: async () => {} }));
const { buildRelease } = await import(${JSON.stringify(build)});
const root = ${JSON.stringify(root)}, calls: unknown[] = [];
Bun.spawn = ((argv: string[], options: any) => {
  calls.push({ argv, env: options.env ? {
    PACER_BUILD_APPLE_TEAM_ID: options.env.PACER_BUILD_APPLE_TEAM_ID,
    PACER_BUILD_SIGNING_CERT_SHA1: options.env.PACER_BUILD_SIGNING_CERT_SHA1,
  } : undefined });
  const out = argv[0] === "cargo"
    ? join(root, "target", argv[argv.indexOf("--target") + 1], "release/pacer")
    : argv[argv.indexOf("--outfile") + 1];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "compiler fixture");
  return { stdout: new Response("").body!, stderr: new Response("").body!, exited: Promise.resolve(0) };
}) as typeof Bun.spawn;
await buildRelease({root, version:"0.8.0", bunExe:"fixture-bun", desktopTrust:{signingCertSha1:"B".repeat(40)}, targets:[{os:"darwin",arch:"arm64",bunTarget:"bun-darwin-arm64"}]});
console.log(JSON.stringify(calls));
`);
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe("");
  expect(code).toBe(0);
  const calls = JSON.parse(out) as {argv:string[];env?:Record<string,string>}[];
  expect(calls).toHaveLength(2);
  expect(calls[0]!.argv).toContain(`PACER_BUILD_SIGNING_CERT_SHA1="${"B".repeat(40)}"`);
  expect(calls[1]!.env?.PACER_BUILD_SIGNING_CERT_SHA1).toBe("B".repeat(40));
  expect(calls[1]!.env?.PACER_BUILD_APPLE_TEAM_ID).toBe("");
});
