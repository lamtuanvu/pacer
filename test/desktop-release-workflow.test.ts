import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const jobs = (Bun.YAML.parse(readFileSync(".github/workflows/release.yml", "utf8")) as any).jobs;
test("desktop promotion requires the native signed build and standalone release while CLI publishing stays independent", () => {
  expect(jobs.publish.needs).toEqual(["verify", "build", "desktop"]);
  expect(jobs.desktop.strategy.matrix.include.every((entry: any) => entry.platform.startsWith("linux-"))).toBe(true);
  for (const job of [jobs.desktop, jobs["desktop-build"]]) {
    const installs = job.steps.filter((s: any) => s.run === "bun install --frozen-lockfile").map((s: any) => s["working-directory"] ?? ".");
    expect(installs).toEqual([".", "desktop"]);
  }
  expect(jobs["desktop-publish"].needs).toEqual(["verify", "desktop-build", "publish"]);
  expect(jobs["desktop-build"].strategy.matrix.include).toEqual([
    { runner: "macos-15", arch: "aarch64", target: "aarch64-apple-darwin", bun_target: "darwin-arm64" },
    { runner: "macos-15", arch: "x86_64", target: "x86_64-apple-darwin", bun_target: "darwin-x64" },
  ]);
  expect(jobs["desktop-build"].strategy.matrix.include.every((entry: any) => entry.runner === "macos-15")).toBe(true);
  expect(jobs["desktop-build"].strategy.matrix.include.some((entry: any) => /intel/i.test(entry.runner))).toBe(false);
  const cross = jobs["desktop-build"].strategy.matrix.include.find((entry: any) => entry.arch === "x86_64");
  expect(cross.target).toBe("x86_64-apple-darwin");
  expect(cross.bun_target).toBe("darwin-x64");
  expect(jobs["desktop-build"].permissions.contents).toBe("read");
  expect(jobs["desktop-publish"].permissions.contents).toBe("write");
  expect(jobs["desktop-build"].if).toContain("PACER_DESKTOP_RELEASE_ENABLED");
  // Stable and nightly versions build and publish the desktop app; other prereleases never do.
  for (const job of ["desktop-build", "desktop-publish"]) {
    expect(jobs[job].if).toContain("(needs.verify.outputs.channel == 'stable' || needs.verify.outputs.channel == 'nightly')");
    expect(jobs[job].if).not.toContain("!contains");
  }
  expect(jobs["desktop-build"].if).toContain("'push'");
});
test("signed desktop builds use compile-time production trust, separate bundled CLI outputs, and unconditional credential cleanup", () => {
  const steps = jobs["desktop-build"].steps;
  const body = steps.map((s: any) => s.run ?? "").join("\n");
  expect(body).toContain("--features ota-production");
  expect(body).toContain("--desktop-production --out dist/desktop-cli");
  expect(body).toContain('--targets "$BUN_TARGET"');
  expect(body).not.toContain("build.ts --host");
  expect(body).toContain('tauri build --target "$TARGET"');
  expect(body).toContain("cargo build --offline --locked --release --target \"$TARGET\"");
  expect(body).toContain('target/$TARGET/release/bundle/macos/pacer.app');
  expect(body).toContain("lipo -archs");
  expect(body).toContain('rustup target add "$TARGET"');
  expect(body).toContain("desktop-credentials.ts");
  const cleanup = steps.find((s: any) => s.name === "Clean ephemeral signing credentials");
  expect(cleanup.if).toBe("always()");
  expect(cleanup.run).toContain("--cleanup");
  expect(body).not.toContain("--clobber");
  const attest = steps.find((s: any) => s.uses?.startsWith("actions/attest-build-provenance"));
  expect(attest.with["subject-path"].trim().split("\n")).toEqual(["dist/desktop-assets/*.app.tar.gz", "dist/desktop-assets/*.dmg"]);
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
  const trust = steps.find((s: any) => s.name === "Verify Apple Silicon runner and production trust").run;
  expect(trust).toContain('test -n "$PACER_APPLE_TEAM_ID" || test -n "$PACER_SIGNING_CERT_SHA1"');
  expect(trust).toContain('test "$(uname -m)" = arm64');
  expect(trust).toContain("arch -x86_64 /usr/bin/true");
  expect(trust).not.toContain('test "$actual" = "$ARCH"');
  const sign = steps.find((s: any) => s.name?.startsWith("Sign complete app"));
  expect(sign.env.PACER_SELF_SIGNING_CERTIFICATE_BASE64).toBe("${{ secrets.PACER_SELF_SIGNING_CERTIFICATE_BASE64 }}");
  expect(sign.env.PACER_SELF_SIGNING_CERTIFICATE_PASSWORD).toBe("${{ secrets.PACER_SELF_SIGNING_CERTIFICATE_PASSWORD }}");
});

test("opted-in release dry runs sign both production desktops without publishing their feed", () => {
  expect(jobs["desktop-build"].if).toContain("github.event_name == 'workflow_dispatch' && inputs.dry_run");
  expect(jobs["desktop-publish"].if).toContain("github.event_name == 'push'");
  expect(jobs["desktop-publish"].if).not.toContain("workflow_dispatch");
});
