// test/ci-service-survival.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("CI runs the Linux restart survival check whenever Bun checks run", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const job = workflow.split("\n  linux-service-survival:\n")[1]?.split(/\n  [a-z-]+:\n/)[0] ?? "";
  expect(job).toContain("runs-on: ubuntu-latest");
  expect(job).toContain("if: ${{ needs.changes.outputs.bun == 'true' }}");
  expect(job).toContain("sudo loginctl enable-linger");
  expect(job).toContain("run: bun scripts/ci/service-survival.ts");
});

test("without a user service manager the check reports UNVERIFIED and passes", async () => {
  const child = Bun.spawn([process.execPath, join(root, "scripts/ci/service-survival.ts")], {
    env: { PATH: "/nonexistent", HOME: process.env.HOME, PACER_SURVIVAL_SYSTEMCTL: "/nonexistent/systemctl" }, stdout: "pipe", stderr: "pipe",
  });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  expect(out).toStartWith("UNVERIFIED: Linux service restart survival");
});
