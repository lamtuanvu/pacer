// test/docs-service-upgrade.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

test("REPO-7: every documentation page names the running-work behaviour", async () => {
  expect(read("README.md")).toContain("### Updating pacer");
  expect(read("README.md")).toContain("kept running");
  expect(read("docs/install.md")).toContain("KillMode=process");
  expect(read("docs/install.md")).toContain("pacer service uninstall --stop-work");
  expect(read("docs/install.md")).toContain("first upgrade into this version");
  expect(read("docs/desktop-updates.md")).toContain("Desktop updates still wait for running work");
  expect(read("docs/testing/live-validation.md")).toContain("## Service upgrade with running work");
  for (const scenario of ["upgrade-headless", "upgrade-interactive", "upgrade-strict", "upgrade-terminal", "upgrade-first-hop", "upgrade-rollback", "upgrade-install"]) expect(read("docs/testing/live-validation.md")).toContain(scenario);
  expect(read("docs/testing/ci-selection.md")).toContain("Linux service restart keeps running work");
  expect(read("CHANGELOG.md").split("## [Unreleased]")[1]?.split(/\n## \[/)[0]).toContain("Upgrading the service no longer interrupts running agents");
  const help = (await main(["help"], fakeCtx())).out;
  expect(help).toContain("uninstall [--stop-work] [--yes]");
  expect(help).toContain("restart the service; running work keeps going");
});
