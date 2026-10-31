import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginRegistry } from "../src/plugins/registry";
import { issueConfiguredHostClone } from "../src/plugins/host-clone-issuer";
import { loadStrategy } from "../src/config/strategy";
import { hostFingerprint } from "../src/plugins/host-drift";
import { controlDir } from "../src/remote/ssh";
import { fakeCtx, realRun, folderPlugins } from "./helpers";
import { releaseReservation, reserveIdle } from "../src/update/desktop/admission";

test("host clone grant pins one fixed SSH effect and preserves uncertain completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-clone-bridge-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo"), bin = join(home, "bin");
  const providerDir = join(pacerHome, "plugins", "pacer-ssh"), ssh = join(bin, "ssh"), log = join(home, "ssh-argv.log");
  mkdirSync(providerDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "session-stream.ts", "pacer-plugin.json"])
    copyFileSync(join(import.meta.dir, "..", "plugins", "pacer-ssh", file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  const successfulSsh = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nnonce=$(printf '%s' "$*" | sed -n 's/.*__PACER_DONE__=\\([a-f0-9-]*\\).*/\\1/p')\nprintf '__PACER_BEGIN__\\n\\n__PACER_DONE__=%s\\n' "$nonce"\n`;
  writeFileSync(ssh, successfulSsh); chmodSync(ssh, 0o755);
  const registry = new PluginRegistry(folderPlugins([providerDir]));
  try {
    const git = async (...args: string[]) => {
      const result = await realRun(["git", ...args], 10_000);
      if (result.code) throw Error(result.stderr);
    };
    await git("init", "-q", "-b", "main", repo);
    await git("-C", repo, "remote", "add", "origin", "https://example.invalid/acme/repo.git");
    writeFileSync(join(pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    repos: {example.invalid/acme/repo: /remote/repo}\n");
    const ctx = fakeCtx({ home, pacerHome, run: realRun,
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
      which: name => name === "ssh" ? ssh : null });
    const snapshot = { alias: "box", key: "example.invalid/acme/repo", path: "/remote/repo",
      origin: "https://example.invalid/acme/repo.git", hostFingerprint: hostFingerprint(loadStrategy(ctx).hosts.box, ["/remote/repo"], true) };
    await registry.enable(ctx, "pacer-ssh", true);
    await expect(registry.call(ctx, "pacer-ssh", "hostRunner.run", {
      session: "a".repeat(32), script: "CHECK_REPO", args: ["/remote/repo", "clone", "https://example.invalid/acme/repo.git"],
      timeoutMs: 50_000, maxBytes: 65_536, completionNonce: "123e4567-e89b-42d3-a456-426614174000",
    })).rejects.toMatchObject({ code: "capability_denied" });
    const grant = await issueConfiguredHostClone(ctx, "box", repo, true, snapshot);
    expect(await registry.cloneConfiguredHost(ctx, grant)).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false });
    expect(readFileSync(log, "utf8")).toContain("BatchMode=yes");
    expect(readFileSync(log, "utf8")).toContain("git clone --");
    await expect(registry.cloneConfiguredHost(ctx, grant)).rejects.toMatchObject({ code: "capability_denied" });
    const clearTransaction = "123e4567-e89b-42d3-a456-426614174001";
    const clear = await reserveIdle(ctx, clearTransaction);
    expect(clear.blockers.some(blocker => blocker.label === "Remote clone operation on box")).toBe(false);
    if (clear.reserved) await releaseReservation(ctx, clearTransaction);
    writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nnonce=$(printf '%s' "$*" | sed -n 's/.*__PACER_DONE__=\\([a-f0-9-]*\\).*/\\1/p')\nprintf '__PACER_BEGIN__\\n\\n__PACER_DONE__=%s\\n' "$nonce"\nexit 1\n`);
    chmodSync(ssh, 0o755);
    const failed = await issueConfiguredHostClone(ctx, "box", repo, true, snapshot);
    expect((await registry.cloneConfiguredHost(ctx, failed)).code).toBe(1);
    const failedTransaction = "123e4567-e89b-42d3-a456-426614174003";
    const failedReservation = await reserveIdle(ctx, failedTransaction);
    expect(failedReservation.blockers.some(blocker => blocker.label === "Remote clone operation on box")).toBe(false);
    if (failedReservation.reserved) await releaseReservation(ctx, failedTransaction);
    await registry.disable(ctx, "pacer-ssh");
    const before = readFileSync(log, "utf8"), disabled = await issueConfiguredHostClone(ctx, "box", repo, true, snapshot);
    await expect(registry.cloneConfiguredHost(ctx, disabled)).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(readFileSync(log, "utf8")).toBe(before);
    await registry.enable(ctx, "pacer-ssh", true);
    writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '__PACER_BEGIN__\\n'\n`);
    chmodSync(ssh, 0o755);
    const ambiguous = await issueConfiguredHostClone(ctx, "box", repo, true, snapshot);
    await expect(registry.cloneConfiguredHost(ctx, ambiguous)).rejects.toMatchObject({ code: "plugin_refused" });
    const reservation = await reserveIdle(ctx, "123e4567-e89b-42d3-a456-426614174002");
    expect(reservation.reserved).toBe(false);
    expect(reservation.blockers.some(blocker => blocker.label === "Remote clone operation on box")).toBe(true);
    expect(readFileSync(log, "utf8")).toContain(`ControlPath=${join(controlDir(ctx), "cm-%C")}`);
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
