/**
 * One-off golden recorder for the native dispatch-parts port (B2-5).
 *
 * Records `dispatchPartsFor` replies for disposable homes with fake `claude`,
 * `codex`, `cursor-agent` and `opencode` executables that print fixed `--version`
 * text. The Rust test `crates/dispatch/src/guards/tests.rs` replays each fixture
 * against `pacer_dispatch::guards` and asserts the same JSON.
 *
 * Run before the TS bridge is deleted:
 *   bun scripts/golden/dispatch-parts.ts
 *
 * Recorded paths are rewritten to `<HOME>` so no machine-specific path reaches
 * the repository. No certificate rows are recorded: a certificate fingerprint
 * hashes file identity (inode/mtime), which cannot survive replay in another
 * temporary directory.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { dispatchPartsFor } from "../../src/api/dispatch-parts-bridge";
import { fakeCtx } from "../../test/helpers";
import type { Ctx } from "../../src/types";

const OUT = new URL("../../test/fixtures/dispatch-parts/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  cursor: {kind: cursor}
  ep: {kind: endpoint, usage: unmetered}
execution:
  launch_mode: headless
runners:
  claude-code: {}
  codex: {}
  cursor: {}
  opencode#ep: {model: vendor/m}
`;
const RUNNERS = ["claude-code", "codex", "cursor", "opencode#ep"];

type Version = { code: number; stdout: string; stderr: string };
type Case = {
  name: string;
  params: Record<string, unknown>;
  files?: Record<string, string>;
  versions?: Record<string, Version>;
  /** Call uncached first to fill the version cache, then record the cached reply. */
  prime?: boolean;
};

const cases: Case[] = [
  { name: "guards-basic", params: { kind: "dispatch.executor-guards", runners: RUNNERS } },
  { name: "guards-blocked", params: { kind: "dispatch.executor-guards", runners: RUNNERS },
    files: { "blocked.json": JSON.stringify({ codex: { until: null, reason: "Paused by you" } }) } },
  { name: "guards-draft", params: { kind: "dispatch.executor-guards", runners: RUNNERS,
    draft: { from: "default", set: { classifier: { timeout_ms: 1000 } } } } },
  { name: "exclusions-uncached", params: { kind: "dispatch.enforcement-exclusions", repo: "<HOME>/repo",
    runners: RUNNERS, cached: false },
    versions: { codex: { code: 1, stdout: "", stderr: "boom" } } },
  { name: "exclusions-cached", params: { kind: "dispatch.enforcement-exclusions", repo: "<HOME>/repo",
    runners: RUNNERS, cached: true } },
  { name: "exclusions-cached-after-probe", prime: true,
    params: { kind: "dispatch.enforcement-exclusions", repo: "<HOME>/repo", runners: RUNNERS, cached: true },
    versions: { codex: { code: 1, stdout: "", stderr: "boom" } } },
  { name: "diagnostics", params: { kind: "dispatch.enforcement-diagnostics", repo: "<HOME>/repo", runners: RUNNERS },
    versions: { codex: { code: 1, stdout: "", stderr: "boom" } } },
];

const fix = (value: unknown, home: string): unknown =>
  JSON.parse(JSON.stringify(value).replaceAll(home, "<HOME>"));

for (const c of cases) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pacer-dispatch-parts-")));
  try {
    const home = join(root, ".pacer"), repo = join(root, "repo"), bin = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, "strategy.yaml"), STRATEGY);
    for (const [path, content] of Object.entries(c.files ?? {})) {
      const target = join(home, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    const executables: Record<string, string> = {
      claude: "2.1.281 (Claude Code)",
      codex: "codex-cli 0.164.0",
      "cursor-agent": "2026.11.01-abc",
      opencode: "1.2.3",
    };
    for (const [name, text] of Object.entries(executables)) {
      const result = c.versions?.[name];
      const path = join(bin, name);
      writeFileSync(path, result ? "#!/bin/sh\nprintf '%s' '" + result.stderr + "' >&2\nexit " + result.code + "\n"
        : "#!/bin/sh\necho '" + text + "'\n");
    }
    const which = (name: string) => Object.hasOwn(executables, name) ? join(bin, name) : null;
    const run = async (argv: string[]): Promise<Version> => {
      const name = Object.keys(executables).find(n => argv[0] === join(bin, n));
      const result = name ? c.versions?.[name] : undefined;
      if (result) return { code: result.code, stdout: result.stdout, stderr: result.stderr };
      return { code: 0, stdout: executables[name ?? ""] + "\n", stderr: "" };
    };
    const ctx: Ctx = fakeCtx({ home: root, pacerHome: home, now: 1_800_000_000,
      env: { PATH: bin + ":/usr/bin:/bin", PACER_BIN: join(bin, "pacer") }, which, run });
    ctx.env = { PATH: bin + ":/usr/bin:/bin", PACER_BIN: join(bin, "pacer") };
    const params = JSON.parse(JSON.stringify(c.params).replaceAll("<HOME>", root));
    if (c.prime) await dispatchPartsFor({ ...ctx, readOnly: true } as Ctx, { ...params, cached: false });
    const expected = await dispatchPartsFor({ ...ctx, readOnly: true } as Ctx, params);
    const fixture = {
      params: fix(params, root),
      prime: c.prime ?? false,
      ctx: { now: ctx.now, env: fix(ctx.env, root), which: fix(
        Object.fromEntries(Object.keys(executables).map(n => [n, which(n)])), root),
        run: fix(Object.fromEntries(Object.keys(executables).map(n => {
          const v = c.versions?.[n];
          return [join(bin, n), v ?? { code: 0, stdout: executables[n] + "\n", stderr: "" }];
        })), root) },
      files: { "strategy.yaml": STRATEGY, ...(c.files ?? {}) },
      expected: fix(expected, root),
    };
    writeFileSync(join(OUT, c.name + ".json"), JSON.stringify(fixture, null, 2) + "\n");
    console.log("recorded", c.name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
