import {afterAll, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {mkdtempSync, readdirSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp, parseOpParams} from "../src/api/ops";
import {serviceEffectsBridge, updateEffectsBridge} from "../src/api/install-apply-bridge";
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
const home = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "native-install-apply-"))); homes.push(dir); return dir; };

type Step = {op: "service.install" | "update.apply"; params: unknown; env?: Record<string, string>};
const EFFECT = {installed: true, running: true, restarting: true};

/** Native answers each step through a recording Core bridge that replies with `EFFECT`. */
function native(steps: Step[], dir: string): Array<Record<string, unknown>> {
  const input = steps.map(step => JSON.stringify({op: step.op, params: step.params, home: dir, now: NOW, env: {...BASE_ENV, ...step.env}, effectResult: EFFECT})).join("\n") + "\n";
  return execFileSync(driver(), {input, env: CHILD_ENV}).toString().trim().split("\n").map(line => JSON.parse(line));
}

/**
 * TypeScript's `parseOpParams` (the caller refusals and the schema, never the handler) is the reference: a refused
 * request must fail natively with the same error and no Core effect; an accepted one must request exactly one effect.
 * Neither side runs a service manager or an update.
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
      expect(effects, label).toEqual([{kind: step.op === "service.install" ? "install" : "apply"}]);
    }
  });
  expect(readdirSync(rs)).toEqual([]);
}

test("native service.install refuses and validates like TypeScript and hands consent to Core", () => {
  const install = (params: unknown, env?: Record<string, string>): Step => ({op: "service.install", params, env});
  compare([
    install({consent: true}), install({consent: true, extra: 1}),
    install({}), install(null), install({consent: false}), install({consent: "true"}), install({consent: 1}),
    install([]), install("x"), install(1), install(false),
    install({consent: true}, {PACER_ROLE: "executor"}), install([], {PACER_ROLE: "executor", PACER_ENFORCEMENT_TOKEN: "t"}),
    install({consent: true}, {PACER_ENFORCEMENT_TOKEN: "t"}), install({}, {PACER_ENFORCEMENT_TOKEN: "t"}),
    install({consent: true}, {PACER_ROLE: "planner", PACER_ENFORCEMENT_TOKEN: ""}),
  ]);
}, 600_000);

test("native update.apply refuses and validates like TypeScript and hands the job to Core", () => {
  const apply = (params: unknown, env?: Record<string, string>): Step => ({op: "update.apply", params, env});
  compare([
    apply({}), apply(null), apply({force: true}),
    apply([]), apply("x"), apply(0), apply(false),
    apply({}, {PACER_ROLE: "executor"}), apply(1, {PACER_ROLE: "executor", PACER_ENFORCEMENT_TOKEN: "t"}),
    apply({}, {PACER_ENFORCEMENT_TOKEN: "t"}), apply([], {PACER_ENFORCEMENT_TOKEN: "t"}),
  ]);
}, 600_000);

test("work-grant callers stay on the TypeScript path", () => {
  const steps: Step[] = [
    {op: "service.install", params: {consent: true}, env: {PACER_WORK_GRANT: "pwg_x"}},
    {op: "update.apply", params: {}, env: {PACER_WORK_GRANT: "pwg_x"}},
  ];
  expect(native(steps, home())).toEqual([{forwarded: true}, {forwarded: true}]);
}, 600_000);

test("the Core effects bridge runs only the effect it names", async () => {
  const ctx = fakeCtx({pacerHome: home(), now: NOW});
  for (const request of [undefined, null, [], {}, {kind: "apply"}, {kind: "install "}]) {
    await expect(serviceEffectsBridge(ctx, request)).rejects.toMatchObject({code: "invalid_input", message: "service effect required"});
  }
  for (const request of [undefined, {}, {kind: "install"}]) {
    await expect(updateEffectsBridge(ctx, request)).rejects.toMatchObject({code: "invalid_input", message: "update effect required"});
  }
});

test("the update effect runs the reference update.apply preflight", async () => {
  // A non-standalone core is refused before any download, so neither run touches a release or a binary.
  const deps = {update: {standalone: false}};
  const reply = async (run: () => Promise<unknown>) => { try { return {result: await run()}; } catch (error) { return {error: toApiError(error)}; } };
  const dir = home();
  const ctx = fakeCtx({pacerHome: dir, home: dir, now: NOW});
  const viaBridge = await reply(() => updateEffectsBridge(ctx, {kind: "apply"}, deps));
  expect(viaBridge).toEqual(await reply(() => callOp(ctx, "update.apply", {}, deps)));
  expect(viaBridge).toMatchObject({error: {code: "not_allowed"}});
});
