import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeConfiguredHostClone, issueConfiguredHostClone, validateConfiguredHostClone } from "../src/plugins/host-clone-issuer";
import { loadStrategy } from "../src/config/strategy";
import { hostFingerprint } from "../src/plugins/host-drift";
import { fakeCtx, realRun } from "./helpers";

test("configured clone grant pins one mapped checkout and local origin", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-clone-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo");
  mkdirSync(pacerHome, { recursive: true });
  try {
    const git = async (...args: string[]) => {
      const result = await realRun(["git", ...args], 10_000);
      if (result.code) throw Error(result.stderr);
    };
    await git("init", "-q", "-b", "main", repo);
    await git("-C", repo, "remote", "add", "origin", "https://example.invalid/acme/repo.git");
    const strategy = "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    repos: {example.invalid/acme/repo: /remote/repo}\n";
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy);
    const ctx = fakeCtx({ home, pacerHome, run: realRun });
    const host = loadStrategy(ctx).hosts.box;
    const snapshot = { alias: "box", key: "example.invalid/acme/repo", path: "/remote/repo",
      origin: "https://example.invalid/acme/repo.git", hostFingerprint: hostFingerprint(host, ["/remote/repo"], true) };
    const grant = await issueConfiguredHostClone(ctx, "box", repo, true, snapshot);
    expect(grant.resource).toMatchObject({ alias: "box", script: "CHECK_REPO",
      args: ["/remote/repo", "clone", "https://example.invalid/acme/repo.git"] });
    await expect(validateConfiguredHostClone(ctx, grant)).resolves.toBeUndefined();
    await consumeConfiguredHostClone(ctx, grant);
    await expect(consumeConfiguredHostClone(ctx, grant)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(validateConfiguredHostClone(ctx, { ...grant })).rejects.toMatchObject({ code: "capability_denied" });
    await expect(issueConfiguredHostClone(ctx, "box", repo, true, { ...snapshot, path: "/remote/other" }))
      .rejects.toMatchObject({ code: "capability_denied" });
    const changed = await issueConfiguredHostClone(ctx, "box", repo, true, snapshot);
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy.replace("/remote/repo", "/remote/other"));
    await expect(validateConfiguredHostClone(ctx, changed)).rejects.toMatchObject({ code: "capability_denied" });
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy);
    await git("-C", repo, "remote", "set-url", "origin", "https://example.invalid/acme/other.git");
    await expect(validateConfiguredHostClone(ctx, changed)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(issueConfiguredHostClone(ctx, "box", repo, false, snapshot)).rejects.toMatchObject({ code: "capability_denied" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
