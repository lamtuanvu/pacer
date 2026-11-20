import {afterAll, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readdirSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseOpParams} from "../src/api/ops";
import {agentEffectsBridge} from "../src/api/agent-bridge";
import {toApiError} from "../src/api/errors";
import {fakeCtx} from "./helpers";
import {closedPort, pinnedEnv} from "./isolated-port";

const CLOSED = String(closedPort());
/** The process env of every child, and the base env both sides see, never fall back to the real service port. */
const CHILD_ENV = pinnedEnv({...process.env, PACER_PORT: CLOSED});
const BASE_ENV = {PATH: "/usr/bin:/bin", PACER_PORT: CLOSED};

let binary: string;
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], {env: CHILD_ENV});
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {env: CHILD_ENV}).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}
const NOW = 1_700_000_000.5;
const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, {recursive: true, force: true}); });
const home = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "native-agent-"))); homes.push(dir); return dir; };

type Step = {op: "agent.preview" | "agent.connect" | "agent.undo" | "agent.disconnect"; params: unknown; env?: Record<string, string>};
const EFFECT = {ok: true};
const KIND: Record<Step["op"], string> = { "agent.preview": "preview", "agent.connect": "connect", "agent.undo": "undo", "agent.disconnect": "disconnect" };

/** Native answers each step through a recording Core bridge that replies with `EFFECT`. */
function native(steps: Step[], dir: string): Array<Record<string, unknown>> {
  const input = steps.map(step => JSON.stringify({op: step.op, params: step.params, home: dir, now: NOW, env: {...BASE_ENV, ...step.env}, effectResult: EFFECT})).join("\n") + "\n";
  return execFileSync(driver(), {input, env: CHILD_ENV}).toString().trim().split("\n").map(line => JSON.parse(line));
}

/**
 * TypeScript's `parseOpParams` (the caller refusals and the schema, never the handler) is the reference: a refused
 * request must fail natively with the same error and no Core effect; an accepted one must request exactly one effect.
 * Neither side runs the planner plugin or touches an agent folder.
 */
function compare(steps: Step[]) {
  const ts = home(), rs = home();
  const actual = native(steps, rs);
  steps.forEach((step, i) => {
    const label = JSON.stringify(step);
    const ctx = fakeCtx({pacerHome: ts, home: ts, now: NOW, env: {...BASE_ENV, ...step.env}});
    const {effects, ...reply} = actual[i];
    let refusal: unknown;
    try { parseOpParams(ctx, step.op, step.params); } catch (error) { refusal = toApiError(error); }
    if (refusal) {
      expect(reply, label).toEqual({error: refusal});
      expect(effects, label).toEqual([]);
    } else {
      expect(reply, label).toEqual({result: EFFECT});
      expect(effects, label).toEqual([{kind: KIND[step.op], params: step.params}]);
    }
  });
  expect(readdirSync(rs)).toEqual([]);
}

test("native agent ops refuse and validate like TypeScript and hand the admitted request to Core", () => {
  const preview = (params: unknown, env?: Record<string, string>): Step => ({op: "agent.preview", params, env});
  compare([
    preview({agent: "codex"}), preview({agent: "codex", extra: 1}),
    preview({agent: "codex", consent: "yes"}),
    preview({}), preview(null), preview({agent: "gemini"}), preview({agent: "  codex"}), preview({agent: 1}),
    preview([]), preview("x"), preview(1), preview(false),
    preview({agent: "codex"}, {PACER_ROLE: "executor"}),
    preview({agent: "codex"}, {PACER_ROLE: "executor", PACER_ENFORCEMENT_TOKEN: "t"}),
    preview({agent: "codex"}, {PACER_ASSISTANT_GRANT: `pag_${"0".repeat(64)}`}),
    preview({agent: "codex"}, {PACER_ENFORCEMENT_TOKEN: "t"}),
    preview({}, {PACER_ENFORCEMENT_TOKEN: "t"}),
  ]);
}, 600_000);

test("native agent connect, undo and disconnect refuse and validate like TypeScript", () => {
  const connect = (params: unknown, env?: Record<string, string>): Step => ({op: "agent.connect", params, env});
  const undo = (params: unknown, env?: Record<string, string>): Step => ({op: "agent.undo", params, env});
  const disconnect = (params: unknown, env?: Record<string, string>): Step => ({op: "agent.disconnect", params, env});
  compare([
    connect({agent: "claude-code", consent: true, preview_revision: "rev"}),
    connect({agent: "cursor", consent: false}),
    connect({agent: "opencode", consent: true}),
    connect({agent: "codex", consent: "yes", preview_revision: 1}),
    connect({agent: "codex"}, {PACER_ROLE: "executor"}),
    connect({agent: "codex", consent: true}, {PACER_ROLE: "executor"}),
    undo({agent: "codex", consent: true, preview_revision: "rev"}),
    undo({agent: "codex"}), undo({agent: "codex", consent: true}),
    undo({agent: "codex"}, {PACER_ROLE: "executor"}),
    undo({agent: "codex", preview_revision: "rev"}, {PACER_ENFORCEMENT_TOKEN: "t"}),
    undo({agent: "codex"}, {PACER_ASSISTANT_GRANT: `pag_${"0".repeat(64)}`}),
    disconnect({agent: "codex"}), disconnect({agent: "unknown"}),
    disconnect({agent: "codex", consent: "yes"}),
    disconnect({agent: "codex"}, {PACER_ROLE: "executor"}),
    disconnect({agent: "codex"}, {PACER_ENFORCEMENT_TOKEN: "t", PACER_ASSISTANT_GRANT: `pag_${"0".repeat(64)}`}),
  ]);
}, 600_000);

test("work-grant agent callers stay on the TypeScript path", () => {
  const steps: Step[] = [
    {op: "agent.preview", params: {agent: "codex"}, env: {PACER_WORK_GRANT: "pwg_x"}},
    {op: "agent.connect", params: {agent: "codex", consent: true}, env: {PACER_WORK_GRANT: "pwg_x"}},
  ];
  expect(native(steps, home())).toEqual([{forwarded: true}, {forwarded: true}]);
}, 600_000);

test("the Core agent bridge runs only the effect it names", async () => {
  const ctx = fakeCtx({pacerHome: home(), now: NOW});
  for (const request of [undefined, null, [], {}, {kind: "install"}, {kind: "preview "}]) {
    await expect(agentEffectsBridge(ctx, request)).rejects.toMatchObject({code: "invalid_input", message: "agent effect required"});
  }
});