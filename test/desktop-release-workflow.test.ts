import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const jobs = (Bun.YAML.parse(readFileSync(".github/workflows/release.yml", "utf8")) as any).jobs;
test("desktop promotion requires the native signed build and standalone release while CLI publishing stays independent", () => {
  expect(jobs.publish.needs).toEqual(["verify", "build", "desktop"]);
  expect(jobs.desktop.strategy.matrix.include.every((entry: any) => entry.platform.startsWith("linux-"))).toBe(true);
  expect(jobs["desktop-publish"].needs).toEqual(["verify", "desktop-build", "publish"]);
  // macOS Intel (x86_64) is temporarily not built for release (see DESKTOP_ARCHES).
  expect(jobs["desktop-build"].strategy.matrix.include).toEqual([{ runner: "macos-15", arch: "aarch64" }]);
  expect(jobs["desktop-build"].permissions.contents).toBe("read");
  expect(jobs["desktop-publish"].permissions.contents).toBe("write");
  expect(jobs["desktop-build"].if).toContain("PACER_DESKTOP_RELEASE_ENABLED");
  expect(jobs["desktop-build"].if).toContain("!contains");
  expect(jobs["desktop-build"].if).toContain("'push'");
});
test("signed desktop builds use compile-time production trust, separate bundled CLI outputs, and unconditional credential cleanup", () => {
  const steps = jobs["desktop-build"].steps;
  const body = steps.map((s: any) => s.run ?? "").join("\n");
  expect(body).toContain("--features ota-production");
  expect(body).toContain("--desktop-production --out dist/desktop-cli");
  expect(body).toContain("desktop-credentials.ts");
  const cleanup = steps.find((s: any) => s.name === "Clean ephemeral signing credentials");
  expect(cleanup.if).toBe("always()");
  expect(cleanup.run).toContain("--cleanup");
  expect(body).not.toContain("--clobber");
});
test("dispatch fixture release exercise needs no production credentials and cannot publish", () => {
  const job = jobs["desktop-fixture"];
  expect(job.permissions.contents).toBe("read");
  expect(job.if).toContain("workflow_dispatch");
  const body = job.steps.map((s: any) => s.run ?? "").join("\n");
  expect(body).toContain("desktop-feed-fixture.ts --fixture");
  expect(body).not.toContain(" publish ");
});

test("interim certificate signing is wired through build, signing and publication without Apple-only gates", () => {
  for (const job of ["desktop-build", "desktop-publish"]) expect(jobs[job].env.PACER_SIGNING_CERT_SHA1).toBe("${{ vars.PACER_SIGNING_CERT_SHA1 }}");
  const steps = jobs["desktop-build"].steps;
  const trust = steps.find((s: any) => s.name === "Verify native runner and production trust").run;
  expect(trust).toContain('test -n "$PACER_APPLE_TEAM_ID" || test -n "$PACER_SIGNING_CERT_SHA1"');
  const sign = steps.find((s: any) => typeof s.run === "string" && s.run.includes("desktop-credentials.ts") && !s.run.includes("--cleanup"));
  expect(sign.env.PACER_SELF_SIGNING_CERTIFICATE_BASE64).toBe("${{ secrets.PACER_SELF_SIGNING_CERTIFICATE_BASE64 }}");
  expect(sign.env.PACER_SELF_SIGNING_CERTIFICATE_PASSWORD).toBe("${{ secrets.PACER_SELF_SIGNING_CERTIFICATE_PASSWORD }}");
});
