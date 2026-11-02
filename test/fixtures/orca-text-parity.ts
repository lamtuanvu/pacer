/** Actual TypeScript reference operations for the Rust Orca parity fixtures. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDefaultFolder } from "../../src/exec/account-folder";
import { ORCA_CAPABILITY_METHODS } from "../../src/plugins/executor-orca-protocol";
import { OrcaAttemptSession } from "../../src/plugins/orca-attempt";
import { OrcaClient } from "../../src/exec/orca/client";
import { waitForWorker } from "../../src/exec/orca/wait";
import { providerEnv } from "../../src/exec/launch";
import type { ProviderCfg } from "../../src/config/strategy";
import type { Ctx } from "../../src/types";

type FolderCase = {
  before?: number[]; agent: string; account: Record<string, string>;
  login: { env: Record<string, string>; profile_keys: string[]; login_shell: boolean };
};
type Input =
  | { mode: "folders"; cases: FolderCase[] }
  | { mode: "params"; cases: { method: string; params: unknown }[] }
  | { mode: "reason"; cases: { code: string; message: string }[] }
  | { mode: "wait"; cases: { lines: string[]; prompt: string; preview: string }[] }
  | { mode: "provider"; cases: { source?: string; provider: ProviderCfg }[] };
const input = JSON.parse(await Bun.stdin.text()) as Input;
const root = mkdtempSync(join(tmpdir(), "pacer-orca-text-oracle-"));
const result: unknown[] = [];
try {
  for (const [index, row] of input.cases.entries()) {
    const home = join(root, String(index));
    mkdirSync(home, { mode: 0o700 });
    if (input.mode === "params") {
      const c = row as Extract<Input, {mode: "params"}>["cases"][number];
      result.push(ORCA_CAPABILITY_METHODS[c.method].params.safeParse(c.params).success);
    } else if (input.mode === "folders") {
      const c = row as FolderCase;
      mkdirSync(join(home, "state"), { mode: 0o700 });
      const path = join(home, "state/default-account-folders.json");
      if (c.before !== undefined) writeFileSync(path, new Uint8Array(c.before), { mode: 0o600 });
      const before = c.before === undefined ? null : statSync(path, { bigint: true });
      recordDefaultFolder({ pacerHome: home }, c.agent, c.account, c.login.login_shell ? {
        env: c.login.env, profileKeys: c.login.profile_keys, source: "login-shell",
        shell: "/fixture-shell", umask: {mask: "077"}, folder: [],
      } : {env: c.login.env, source: "service", reason: "fixture"});
      let bytes: number[] | null = null, unchanged = before === null;
      try {
        bytes = [...readFileSync(path)];
        const after = statSync(path, { bigint: true });
        unchanged = before !== null && before.ino === after.ino && before.mtimeNs === after.mtimeNs;
      } catch { /* No record is a valid no-op. */ }
      result.push({ bytes, unchanged });
    } else if (input.mode === "reason") {
      const c = row as Extract<Input, {mode: "reason"}>["cases"][number];
      const client = new OrcaClient(async () => ({ code: 0, stdout: JSON.stringify({ ok: false, error: c }), stderr: "", timedOut: false }), {});
      // Exercise the actual session lookup and bounded reply without launching
      // or registering a session. The only dependency is the fake CLI response.
      const session = Object.assign(Object.create(OrcaAttemptSession.prototype) as OrcaAttemptSession,
        { phase: "uncertain", c: client, p: { run: "fixture" }, terminal: "fixture", log: () => {} });
      result.push(await session.lookup());
    } else if (input.mode === "provider") {
      const c = row as Extract<Input, {mode: "provider"}>["cases"][number];
      if (c.source !== undefined) writeFileSync(join(home, "strategy.yaml"), c.source, { mode: 0o600 });
      const ctx: Ctx = { home, pacerHome: home, now: 1, env: {}, which: () => null,
        run: async () => { throw Error("unexpected external effect"); } };
      try { result.push({ env: await providerEnv(ctx, c.provider, { probe: true }) }); }
      catch (error) { result.push({ error: (error as Error).message, name: (error as Error).name }); }
    } else {
      const c = row as Extract<Input, {mode: "wait"}>["cases"][number];
      const run: Ctx["run"] = async argv => {
        let response: unknown;
        if (argv[1] === "terminal" && argv[2] === "show") response = {terminal: {preview: c.preview}};
        else if (argv[2] === "check") response = {messages: []};
        else if (argv[2] === "worker-read") response = {terminal: {tail: c.lines}};
        else if (argv[2] === "worker-show") response = {worker: {state: "failed", lastError: "fixture stopped"}};
        else throw Error(`unexpected fixture command: ${JSON.stringify(argv)}`);
        return {code: 0, stdout: JSON.stringify({ok: true, result: response}), stderr: "", timedOut: false};
      };
      const ctx: Ctx = {home, pacerHome: home, now: 1, env: {}, which: () => null, run};
      result.push(await waitForWorker(ctx, new OrcaClient(run, {}), {
        coordinator: "coordinator", run: "run", dispatchId: "dispatch-owned", terminal: "agent-terminal",
        providerId: "codex", prompt: c.prompt, deadlineMs: 1000, now: () => 0,
        sleep: async () => {}, isStopped: () => false,
      }));
    }
  }
  console.log(JSON.stringify(result));
} finally { rmSync(root, { recursive: true, force: true }); }
