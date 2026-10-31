import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueConfiguredHostIdentity, validateConfiguredHostIdentity } from "../src/plugins/host-identity-issuer";
import { fakeCtx, realRun } from "./helpers";

test("host identity grant derives exact configured checkout and local Git identity", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-identity-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo");
  mkdirSync(pacerHome, { recursive: true });
  try {
    const git = async (...args: string[]) => {
      const result = await realRun(["git", ...args], 10_000);
      if (result.code) throw Error(result.stderr);
      return result.stdout.trim();
    };
    await git("init", "-q", "-b", "main", repo);
    await git("-C", repo, "remote", "add", "origin", "https://example.invalid/acme/repo.git");
    await git("-C", repo, "config", "user.name", "Example");
    await git("-C", repo, "config", "user.email", "example@example.invalid");
    const strategy = "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    repos: {example.invalid/acme/repo: /remote/repo}\n";
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy);
    const ctx = fakeCtx({ home, pacerHome, run: realRun });
    const grant = await issueConfiguredHostIdentity(ctx, "box", repo);
    expect(grant.resource).toMatchObject({ alias: "box", script: "SET_IDENTITY",
      args: ["/remote/repo", "Example", "example@example.invalid"] });
    await expect(validateConfiguredHostIdentity(ctx, grant)).resolves.toBeUndefined();
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy.replace("/remote/repo", "/remote/other"));
    await expect(validateConfiguredHostIdentity(ctx, grant)).rejects.toMatchObject({ code: "capability_denied" });
    writeFileSync(join(pacerHome, "strategy.yaml"), strategy);
    await git("-C", repo, "config", "user.name", "Changed");
    await expect(validateConfiguredHostIdentity(ctx, grant)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(validateConfiguredHostIdentity(ctx, { ...grant })).rejects.toMatchObject({ code: "capability_denied" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
