import { accountEvidenceScope } from "../src/evidence/scope";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { main } from "../src/cli";
import { loadStrategy } from "../src/config/strategy";
import { check } from "../src/remote/hosts";
import { cachedRemoteUsage, probeCodexUsage } from "../src/remote/usage";
import { readAccountUsage } from "../src/usage";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

function session(home: string, at: number, used: number, file = "rollout-test.jsonl") {
  const dir = join(home, "sessions", "2026", "10");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `${JSON.stringify({ timestamp: new Date(at * 1000).toISOString(), payload: { rate_limits: {
    primary: { used_percent: used, window_minutes: 300, resets_in_seconds: 3600 },
    secondary: { used_percent: 20, window_minutes: 10080, resets_at: at + 7200 },
  } } })}\n`);
  utimesSync(path, at, at);
}

function fixture() {
  const home = tmpDir(), ctx = fakeCtx();
  writeFileSync(join(home, ".bash_profile"), "echo hello from profile\n");
  ctx.env = fakeSshEnv(home, join(home, "ssh.log"));
  ctx.run = (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...ctx.env, ...o?.env } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, team: { kind: "codex", home: "~/.codex-team" } },
    planner: "claude-code", hosts: { box: { ssh: "box-ssh", repos: {}, accounts: { team: { home: "~/.codex-team" } } } },
    routing: [{ default: ["codex@box", "codex#team@box", "codex"] }],
  }));
  const s = loadStrategy(ctx), host = s.hosts.box;
  const read = () => readAccountUsage(ctx, s.accounts.codex, Object.values(s.runners).filter(r => r.account === "codex"));
  return { ctx, home, s, host, read };
}

test("probe parses the fake host session and caches the reading", async () => {
  const { ctx, home, s, host } = fixture();
  session(join(home, ".codex"), ctx.now - 20, 45);
  session(join(home, ".codex"), ctx.now - 100, 90, "rollout-older.jsonl");
  const reading = await probeCodexUsage(ctx, host, s.accounts.codex);
  expect(reading).toMatchObject({ capturedAt: ctx.now - 20, source: "session-log", remoteHost: "box", windows: [
    { name: "5h", usedPct: 45, resetsAt: ctx.now - 20 + 3600 }, { name: "weekly", usedPct: 20 },
  ] });
  expect(JSON.parse(readFileSync(join(ctx.pacerHome, "cache", "remote-usage", "codex.json"), "utf8"))).toEqual({ version: 2, identity: accountEvidenceScope(s.accounts.codex).identity, sourceIdentity: JSON.stringify([host.alias, host.ssh, null]), reading, at: ctx.now });
});

test("probe uses the declared remote account home", async () => {
  const { ctx, home, s, host } = fixture();
  session(join(home, ".codex-team"), ctx.now, 60);
  expect(await probeCodexUsage(ctx, host, s.accounts.team)).toMatchObject({ windows: [{ usedPct: 60 }, {}] });
});

test("newer remote snapshot beats local, while newer local beats remote", async () => {
  for (const remoteNewer of [true, false]) {
    const { ctx, home, s, host, read } = fixture();
    session(join(ctx.home, ".codex"), ctx.now - (remoteNewer ? 100 : 10), 10);
    session(join(home, ".codex"), ctx.now - 50, 70);
    await probeCodexUsage(ctx, host, s.accounts.codex);
    const r = await read();
    expect(r.windows[0].usedPct).toBe(remoteNewer ? 70 : 10);
    expect(r.remoteHost).toBe(remoteNewer ? "box" : undefined);
  }
});

test("remote reading wins when local has no data; older probes never replace a newer snapshot", async () => {
  const { ctx, home, s, host, read } = fixture();
  session(join(home, ".codex"), ctx.now - 10, 70);
  await probeCodexUsage(ctx, host, s.accounts.codex);
  session(join(home, ".codex"), ctx.now - 100, 30);
  await probeCodexUsage(ctx, { ...host, alias: "older" }, s.accounts.codex);
  expect(await read()).toMatchObject({ remoteHost: "box", windows: [{ usedPct: 70 }, {}] });
});

test("local-only account is unaffected and failed probes are harmless", async () => {
  const { ctx, s, host, read } = fixture();
  session(join(ctx.home, ".codex"), ctx.now, 10);
  expect(await read()).toMatchObject({ source: "session-log", windows: [{ usedPct: 10 }, {}] });
  expect(await probeCodexUsage(ctx, host, s.accounts.codex)).toBeNull();
  ctx.env.PACER_FAKE_SSH_DOWN = "box-ssh";
  expect(await probeCodexUsage(ctx, host, s.accounts.codex)).toBeNull();
  expect((await read()).remoteHost).toBeUndefined();
});

test("limits check shows session-log (via box)", async () => {
  const { ctx, home, s, host } = fixture();
  session(join(home, ".codex"), ctx.now, 10);
  await probeCodexUsage(ctx, host, s.accounts.codex);
  const result = await main(["limits", "check"], ctx);
  expect(result.code).toBe(0);
  expect(result.out).toContain("session-log (via box)");
});

test("host check probes Codex accounts", async () => {
  const { ctx, home, read } = fixture();
  session(join(home, ".codex"), ctx.now, 40);
  await check(ctx, "box");
  expect(await read()).toMatchObject({ remoteHost: "box", windows: [{ usedPct: 40 }, {}] });
});

 test("changed remote account home invalidates cached observations and nested alternatives", async () => {
  const { ctx, home, s, host } = fixture();
  session(join(home, ".codex"), ctx.now - 10, 70);
  session(join(home, ".codex"), ctx.now - 20, 50, "rollout-other.jsonl");
  await probeCodexUsage(ctx, host, s.accounts.codex);
  const changed = { ...host, accounts: { ...host.accounts, codex: { home: "~/.replacement" } } };
  const cached = cachedRemoteUsage(ctx, s.accounts.codex, { box: changed });
  expect(cached?.capturedAt).toBeNull();
  expect(cached?.alternatives).toBeUndefined();
  expect(accountEvidenceScope(s.accounts.codex, { box: changed }).identity).not.toBe(accountEvidenceScope(s.accounts.codex, { box: host }).identity);
 });
