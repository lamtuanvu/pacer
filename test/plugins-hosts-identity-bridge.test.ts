import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginRegistry } from "../src/plugins/registry";
import { issueConfiguredHostIdentity } from "../src/plugins/host-identity-issuer";
import { manifestSchema } from "../src/plugins/protocol";
import { fakeCtx, realRun } from "./helpers";
import { releaseReservation, reserveIdle } from "../src/update/desktop/admission";

test("host-owned identity grant pins one SSH effect and hides its completion receipt", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-identity-bridge-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo"), bin = join(home, "bin");
  const providerDir = join(pacerHome, "plugins", "pacer-ssh");
  mkdirSync(providerDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "session-stream.ts", "pacer-plugin.json"])
    copyFileSync(join(import.meta.dir, "..", "plugins", "pacer-ssh", file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(home, "ssh-argv.log")}'\ncase "$*" in\n  *"__PACER_DONE__="*) nonce=$(printf '%s' "$*" | sed -n 's/.*__PACER_DONE__=\\([a-f0-9-]*\\).*/\\1/p'); printf '__PACER_BEGIN__\\n\\n__PACER_DONE__=%s\\n' "$nonce" ;;\n  *) printf '__PACER_BEGIN__\\n' ;;\nesac\n`);
  chmodSync(ssh, 0o755);
  const manifest = manifestSchema.parse({ id: "host-broker-caller", version: "1.0.0", publisher: "pacer",
    host: "^1.5", contributes: {}, capabilities: [{ name: "hosts" }], reentrant: true });
  const registry = new PluginRegistry({ bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({ argv: [process.execPath, join(import.meta.dir, "fixtures", "host-broker", "caller.ts")],
      cwd: home, env: {} }), eventPumpMs: 0 });
  try {
    const git = async (...args: string[]) => {
      const result = await realRun(["git", ...args], 10_000);
      if (result.code) throw Error(result.stderr);
    };
    await git("init", "-q", "-b", "main", repo);
    await git("-C", repo, "remote", "add", "origin", "https://example.invalid/acme/repo.git");
    await git("-C", repo, "config", "user.name", "Example");
    await git("-C", repo, "config", "user.email", "example@example.invalid");
    writeFileSync(join(pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    repos: {example.invalid/acme/repo: /remote/repo}\n");
    const ctx = fakeCtx({ home, pacerHome, run: realRun,
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
      which: name => name === "ssh" ? ssh : null });
    await registry.enable(ctx, "pacer-ssh", true);
    await expect(registry.call(ctx, "host-broker-caller", "diagnostic.ping", { mode: "identity" }))
      .rejects.toMatchObject({ code: "capability_denied" });
    const grant = await issueConfiguredHostIdentity(ctx, "box", repo);
    const result = await registry.callWithIssuedHostIdentity<{ identity: {
      code: number; stdout: string; stderr: string; timedOut: boolean } }>(
      ctx, "host-broker-caller", "diagnostic.ping", { mode: "identity" }, grant);
    expect(result.identity).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false });
    expect(readFileSync(join(home, "ssh-argv.log"), "utf8")).toContain("config --local user.email");
    const clearTransaction = "123e4567-e89b-42d3-a456-426614174002";
    const clear = await reserveIdle(ctx, clearTransaction);
    expect(clear.blockers.some(blocker => blocker.label === "Remote identity operation on box")).toBe(false);
    if (clear.reserved) await releaseReservation(ctx, clearTransaction);
    await expect(registry.callWithIssuedHostIdentity(ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "identity" }, grant)).rejects.toMatchObject({ code: "capability_denied" });
    writeFileSync(ssh, "#!/bin/sh\nprintf '__PACER_BEGIN__\\n'\n");
    chmodSync(ssh, 0o755);
    const ambiguous = await issueConfiguredHostIdentity(ctx, "box", repo);
    await expect(registry.callWithIssuedHostIdentity(ctx, "host-broker-caller", "diagnostic.ping",
      { mode: "identity" }, ambiguous)).rejects.toMatchObject({ code: "plugin_refused" });
    const reservation = await reserveIdle(ctx, "123e4567-e89b-42d3-a456-426614174001");
    expect(reservation.reserved).toBe(false);
    expect(reservation.blockers.some(blocker => blocker.label === "Remote identity operation on box")).toBe(true);
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
