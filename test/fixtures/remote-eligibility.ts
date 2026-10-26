import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadStrategy } from "../../src/config/strategy";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "../helpers";

/** Exercise the pinned SSH provider while keeping all SSH effects in a temp host. */
export function remoteEligibilityFixture() {
  const home = tmpDir(), ctx = fakeCtx();
  const log = join(home, "ssh.log");
  const down = join(home, "down-host.txt");
  writeFileSync(down, "");
  ctx.env = fakeSshEnv(home, log);
  ctx.run = (argv, ms, options) => realRun(argv, ms, { ...options, env: { ...ctx.env, ...options?.env } });
  const ssh = join(home, "ssh-fixture");
  writeFileSync(ssh, `#!/bin/sh\nPACER_FAKE_HOST_HOME=${JSON.stringify(home)} PACER_FAKE_SSH_LOG=${JSON.stringify(log)} PACER_FAKE_SSH_DOWN="$(cat ${JSON.stringify(down)})" exec ${JSON.stringify(join(import.meta.dir, "bin", "ssh"))} "$@"\n`);
  chmodSync(ssh, 0o755);
  ctx.which = name => name === "ssh" ? ssh : null;
  mkdirSync(ctx.pacerHome, { recursive: true });
  const strategyFile = join(ctx.pacerHome, "strategy.yaml");
  const setTarget = (sshTarget: string) => {
    writeFileSync(strategyFile, stringify({
      accounts: { claude: { kind: "claude" }, codex: { kind: "codex" } }, planner: "claude-code",
      hosts: { box: { ssh: sshTarget, repos: {} } }, routing: [{ default: ["codex@box", "codex"] }],
    }));
    return loadStrategy(ctx);
  };
  return { ctx, home, log, setTarget, setDown: (alias: string) => writeFileSync(down, alias), strategy: setTarget("box-ssh") };
}
