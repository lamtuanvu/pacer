/** Fixed M2 wave-2 host-effects fixture. No caller-selected operation, host, payload, path or environment. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import {
  atomicWrite, FAKE_SSH_ALIAS, FAKE_SSH_DOWN_ALIAS, fakeHostHome, fakeSshLog, healthy, record, run, sandboxEnv, shellQuote, verifyFakeSsh, type Session,
} from "./core";

/** `fakehost` answers through the fake ssh; `downhost` is refused by it, as an unreachable host would be. */
const HOSTS = {
  fakehost: { ssh: FAKE_SSH_ALIAS, max_tasks: 1, accounts: { team: { home: "~/.codex-team" } } },
  downhost: { ssh: FAKE_SSH_DOWN_ALIAS, max_tasks: 1 },
};
const EXPECTED = { fakehost: "passed", downhost: "failed" } as const;
type Alias = keyof typeof EXPECTED;
const ALIASES = Object.keys(EXPECTED) as Alias[];
const FIXTURE = "native-host-effects";

interface Job {
  id: string;
  kind: string;
  target: string;
  state: string;
  steps: { name: string; state: string; detail?: string }[];
  startedAt: number;
  endedAt?: number;
  pid: number;
  cancellable: boolean;
  error?: { code: string; message: string; hint?: string };
}
interface Api { base: string; token: string }
export type Dispatch = "native" | "forwarded";

/** The job without values that differ between runs: id, owning pid and timestamps. */
export function normalizeJob(job: Job): Omit<Job, "id" | "pid" | "startedAt" | "endedAt"> {
  const { id: _id, pid: _pid, startedAt: _startedAt, endedAt: _endedAt, ...rest } = job;
  return rest;
}

/** Public v3 `job` events from an SSE transcript, in stream order, for the given job IDs. */
export function jobEvents(transcript: string, ids: string[]): Record<string, Job[]> {
  const events: Record<string, Job[]> = Object.fromEntries(ids.map(id => [id, []]));
  for (const frame of transcript.split("\n\n")) {
    const lines = frame.split("\n");
    if (!lines.includes("event: job")) continue;
    const data = lines.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
    let job: Job;
    try { job = JSON.parse(data); } catch { continue; }
    if (typeof job?.id === "string" && Object.hasOwn(events, job.id)) events[job.id].push(job);
  }
  return events;
}

/** SSH calls per alias in the fake ssh log. Entries span several lines because remote programs contain newlines. */
export function fakeSshCalls(log: string): Record<string, number> {
  const calls: Record<string, number> = {};
  for (const line of log.split("\n")) {
    const alias = /^(\S+) -o BatchMode=yes /.exec(line)?.[1];
    if (alias) calls[alias] = (calls[alias] ?? 0) + 1;
  }
  return calls;
}

/**
 * Classify `host.check` dispatch from the service's `PACER_DEBUG_NATIVE` trace. A native `job.get` trace must be
 * present, so an absent `native host.check` line means forwarding rather than a missing trace channel.
 */
export function hostCheckDispatch(trace: string, checks: number, forced: boolean): Dispatch {
  const lines = trace.split("\n");
  if (!lines.some(line => line === "native job.get" || line.startsWith("native job.get "))) {
    throw Error("service trace has no native job.get line; native dispatch evidence is inconclusive");
  }
  const native = lines.filter(line => line === "native host.check" || line.startsWith("native host.check ")).length;
  if (forced) {
    if (native) throw Error("forced-forward session executed host.check natively");
    return "forwarded";
  }
  if (native === 0) return "forwarded";
  if (native !== checks) throw Error(`native host.check traced ${native} times for ${checks} checks`);
  return "native";
}

function strategy(session: Session) {
  let text: string;
  try { text = readFileSync(join(session.root, "home/strategy.yaml"), "utf8"); }
  catch { throw Error(`The sandbox strategy is missing (${session.id}); start a fresh sandbox`); }
  const doc = parseDocument(text);
  if (doc.errors.length || doc.has("hosts")) throw Error(`The sandbox strategy is invalid or already declares hosts (${session.id}); start a fresh sandbox`);
  return doc;
}

/** Refuses a used fake host, fixture output or host declaration. Reads only, so both sandboxes are checked before either is used. */
export function requireFresh(session: Session): void {
  const root = session.root;
  if ([join(root, FIXTURE), fakeSshLog(root), join(fakeHostHome(root), ".bash_profile"), join(root, "fake-host/bin")].some(path => existsSync(path))) {
    throw Error(`The sandbox fake host or fixture output was already used (${session.id}); start a fresh sandbox`);
  }
  strategy(session);
}

/**
 * Fake host login profile: `setsid` and util-linux `script` stand-ins so the prerequisites can pass on any OS,
 * and the declared account home. The fake ssh keeps an existing profile.
 */
function prepareFakeHost(root: string): void {
  const home = fakeHostHome(root), bin = join(root, "fake-host/bin");
  mkdirSync(bin, { mode: 0o700 });
  atomicWrite(join(bin, "setsid"), '#!/bin/sh\nexec "$@"\n', 0o700);
  atomicWrite(join(bin, "script"), "#!/bin/sh\n[ \"$1\" = --version ] || exit 1\necho 'script from util-linux 2.39.3'\n", 0o700);
  mkdirSync(join(home, ".codex-team"), { mode: 0o700 });
  atomicWrite(join(home, ".bash_profile"), `PATH=${shellQuote(bin)}:"$PACER_FAKE_HOST_PATH"; export PATH\n`);
}

/** The fixture owns this host declaration; the guarded CLI refuses the host forms that would write one. */
function configureHosts(session: Session): void {
  const doc = strategy(session);
  doc.set("hosts", HOSTS);
  atomicWrite(join(session.root, "home/strategy.yaml"), doc.toString());
}

async function call(api: Api, op: string, params: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${api.base}/v3/ops/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${api.token}`, "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() };
}

async function settledJob(api: Api, id: string): Promise<Job> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const reply = await call(api, "job.get", { id });
    if (reply.status !== 200 || !reply.body.result) throw Error(`job.get failed: ${JSON.stringify(reply.body)}`);
    if (reply.body.result.state !== "running") return reply.body.result;
    await Bun.sleep(200);
  }
  throw Error(`host.check job ${id} did not settle`);
}

/** A public SSE subscription through the guarded proxy, collected in the background. */
function subscribe(api: Api) {
  const controller = new AbortController();
  let transcript = "", failure: unknown;
  const reading = (async () => {
    const response = await fetch(`${api.base}/v3/events?since=0`, { headers: { authorization: `Bearer ${api.token}` }, signal: controller.signal });
    if (!response.ok || !response.body) throw Error(`public SSE subscription failed (${response.status})`);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) throw Error("public SSE stream ended");
      transcript += decoder.decode(next.value, { stream: true });
    }
  })().catch(error => { if (!controller.signal.aborted) failure = error; });
  return {
    async settled(jobs: Job[]): Promise<Record<string, Job[]>> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        const events = jobEvents(transcript, jobs.map(job => job.id));
        if (jobs.every(job => events[job.id].at(-1)?.state === job.state)) return events;
        await Bun.sleep(50);
      }
      throw Error("public SSE did not deliver the settled job events");
    },
    async close(): Promise<void> { controller.abort(); await reading; },
  };
}

const outcome = (state: string) => state === "passed";
/** One sandbox: both fixed host checks through the guarded proxy, with their job files, host-checks.json and SSE events. */
async function exerciseSession(session: Session, forced: boolean) {
  const home = join(session.root, "home");
  const surface = "API (guarded proxy)";
  prepareFakeHost(session.root);
  configureHosts(session);
  const serveLog = join(session.root, "logs/serve.log");
  const offset = statSync(serveLog).size;
  const api = { base: `http://127.0.0.1:${session.port}`, token: readFileSync(join(home, "token"), "utf8").trim() };
  const events = subscribe(api);
  const replies: Job[] = [], settled: Job[] = [];
  let published: Record<string, Job[]> = {};
  try {
    for (const alias of ALIASES) {
      const reply = await call(api, "host.check", { alias });
      const job: Job | undefined = reply.body?.result?.job;
      if (reply.status !== 200 || !job?.id || job.kind !== "host.check" || job.target !== alias) {
        throw Error(`host.check ${alias} did not reply with its job: ${reply.status} ${JSON.stringify(reply.body)}`);
      }
      const final = await settledJob(api, job.id);
      if (final.state !== EXPECTED[alias]) throw Error(`host.check ${alias} settled ${final.state}, expected ${EXPECTED[alias]}: ${JSON.stringify(final)}`);
      const file = join(home, "state/jobs", `${job.id}.json`);
      if ((statSync(file).mode & 0o777) !== 0o600 || !isDeepStrictEqual(JSON.parse(readFileSync(file, "utf8")), final)) {
        throw Error(`job file for ${alias} is not private or differs from job.get`);
      }
      replies.push(job);
      settled.push(final);
    }
    published = await events.settled(settled);
  } finally { await events.close(); }
  const stored = JSON.parse(readFileSync(join(home, "state/host-checks.json"), "utf8"));
  for (const [index, alias] of ALIASES.entries()) {
    const entry = stored[alias], job = settled[index];
    const steps = job.steps.map(step => step.name);
    if (!entry || entry.ok !== outcome(EXPECTED[alias]) || !isDeepStrictEqual(entry.checks.map((check: { name: string }) => check.name), steps)) {
      throw Error(`host-checks.json entry for ${alias} does not match its job`);
    }
    const states = published[job.id].map(value => value.state);
    if (states[0] !== "running" || states.at(-1) !== job.state) throw Error(`public SSE job events for ${alias} lack the running or settled state`);
  }
  if (settled[0].steps.find(step => step.name === "ssh")?.state !== "passed") throw Error("the fake host did not answer the probe");
  if (settled[1].steps.find(step => step.name === "ssh")?.detail !== "unreachable") throw Error("the refused host was not reported unreachable");
  const calls = fakeSshCalls(readFileSync(fakeSshLog(session.root), "utf8"));
  const count = (alias: string) => calls[alias] ?? 0;
  if (!count(FAKE_SSH_ALIAS) || !count(FAKE_SSH_DOWN_ALIAS) || Object.keys(calls).some(alias => alias !== FAKE_SSH_ALIAS && alias !== FAKE_SSH_DOWN_ALIAS)) {
    throw Error("the fake ssh log does not show exactly the fixture hosts; ssh may have resolved elsewhere");
  }
  record(session, { kind: "note", behavior: "Sandbox ssh is the fake host", surface: "sandbox PATH", verdict: "PASS",
    steps: "Resolve ssh on the sandbox PATH; compare bin/ssh bytes; read fake-host/ssh.log after the checks",
    text: `ssh resolves to bin/ssh (test/fixtures/bin/ssh with a sandbox fake host home). The fake logged ${count(FAKE_SSH_ALIAS)} call(s) for ${FAKE_SSH_ALIAS} and ${count(FAKE_SSH_DOWN_ALIAS)} for ${FAKE_SSH_DOWN_ALIAS}, and no other host.` });
  for (const [index, alias] of ALIASES.entries()) {
    record(session, { kind: "note", behavior: `host.check job lifecycle (${alias})`, surface, verdict: "PASS",
      steps: `POST /v3/ops/host.check {"alias":"${alias}"}; poll job.get; read state/jobs, state/host-checks.json and /v3/events`,
      text: `Replied {job} (running); job settled ${settled[index].state}; the 0600 job file equals job.get; host-checks.json holds the same checks; public SSE delivered ${published[settled[index].id].length} job event(s) from running to ${settled[index].state}.` });
  }
  const dispatch = hostCheckDispatch(readFileSync(serveLog).subarray(offset).toString(), ALIASES.length, forced);
  const result = {
    replies: replies.map(normalizeJob),
    jobs: settled.map(normalizeJob),
    hostChecks: Object.fromEntries(ALIASES.map(alias => { const { at: _at, ...entry } = stored[alias]; return [alias, entry]; })),
    events: settled.map(job => published[job.id].map(normalizeJob)),
  };
  // Fake host tool paths name each sandbox's own root.
  return { dispatch, result: JSON.parse(JSON.stringify(result).replaceAll(session.root, "$SANDBOX")) };
}

/** The D8 proxy and D3 wrapper keep refusing host.clean and host.repo.setup; their op-level behavior stays UNVERIFIED live. */
async function recordRefusals(session: Session): Promise<void> {
  const api = { base: `http://127.0.0.1:${session.port}`, token: readFileSync(join(session.root, "home/token"), "utf8").trim() };
  const attempts = { "host.clean": { alias: "fakehost", dry_run: true }, "host.repo.setup": { alias: "fakehost", key: "github.com/pacer-live/fixture", consent: true } };
  for (const [op, params] of Object.entries(attempts)) {
    const reply = await call(api, op, params);
    if (reply.status !== 403 || reply.body?.error?.code !== "forbidden" || !String(reply.body.error.message).startsWith(`Live validation D8: ${op}`)) {
      throw Error(`D8 did not refuse ${op}: ${reply.status} ${JSON.stringify(reply.body)}`);
    }
  }
  const setup = await run([sandboxEnv(session).PACER_BIN!, "host", "setup", "fakehost"], session);
  if (setup.code !== 3 || !setup.stderr.includes("D3")) throw Error(`D3 did not refuse host setup (exit ${setup.code})`);
  record(session, { kind: "note", behavior: "host.clean op-level effects", surface: "API (guarded proxy)", verdict: "UNVERIFIED",
    steps: 'POST /v3/ops/host.clean {"alias":"fakehost","dry_run":true}',
    text: "D8 refused with 403 forbidden as designed, before the service. Live op-level behavior is not exercised; the end-to-end native/forwarded differential tests are the op-level evidence." });
  record(session, { kind: "note", behavior: "host.repo.setup op-level effects", surface: "API (guarded proxy) and CLI", verdict: "UNVERIFIED",
    steps: "POST /v3/ops/host.repo.setup with consent; live pacer -- host setup fakehost",
    text: "D8 refused the operation with 403 forbidden and D3 refused the CLI form with exit 3, as designed. Live op-level behavior is not exercised; the end-to-end differential tests are the op-level evidence." });
}

/** The guarded CLI check runs the TypeScript core in its own process and must write the same shared host-checks.json entry. */
async function cliCheck(session: Session): Promise<void> {
  const file = join(session.root, "home/state/host-checks.json");
  const before = JSON.parse(readFileSync(file, "utf8")).fakehost;
  const result = await run([sandboxEnv(session).PACER_BIN!, "host", "check", "fakehost", "--json"], session);
  if (result.code !== 0) throw Error(`guarded host check failed (exit ${result.code}): ${result.stderr}`);
  const reply = JSON.parse(result.stdout);
  const after = JSON.parse(readFileSync(file, "utf8")).fakehost;
  if (reply.alias !== "fakehost" || reply.ok !== true || !isDeepStrictEqual(reply.checks, after.checks) || !isDeepStrictEqual(reply.facts, after.facts)
    || !isDeepStrictEqual(after.checks, before.checks) || !isDeepStrictEqual(after.facts, before.facts) || after.at < before.at) {
    throw Error("guarded CLI host check and the API check disagree in host-checks.json");
  }
  record(session, { kind: "note", behavior: "host check CLI shares host-checks.json", surface: "CLI", verdict: "PASS",
    steps: "live pacer -- host check fakehost --json after the API check",
    text: "The guarded CLI check (TypeScript core in process) returned ok and wrote the same checks and facts the API job wrote, with a newer timestamp." });
}

function requireSession(session: Session, forced: boolean): void {
  const forward = forced ? session.nativeForwardOps === "host.check" : session.nativeForwardOps === undefined;
  if (session.frontDoor !== "rust" || !session.nativeTestOps || session.nativeForwardEcho || !forward || session.coreFixture
    || session.realKeychain || session.waitingFixture || session.stopped) {
    throw Error(forced
      ? "native-host-effects --forward-id requires a Rust test-ops sandbox started with --native-forward-ops host.check and the Keychain stub"
      : "native-host-effects --id requires a Rust test-ops sandbox without forwarded ops, core fixture or real Keychain");
  }
}

/** Drive host.check on a native test-ops sandbox and a `--native-forward-ops host.check` sandbox, then compare. */
export async function exerciseNativeHostEffects(native: Session, forward: Session): Promise<void> {
  if (native.id === forward.id) throw Error("native-host-effects needs two different sandboxes");
  requireSession(native, false);
  requireSession(forward, true);
  // Fail closed before any request: a host check must never reach a real ssh or host.
  for (const session of [native, forward]) verifyFakeSsh(session);
  for (const session of [native, forward]) requireFresh(session);
  for (const session of [native, forward]) if (!await healthy(session)) throw Error(`native-host-effects requires a healthy sandbox (${session.id})`);
  for (const session of [native, forward]) mkdirSync(join(session.root, FIXTURE), { mode: 0o700 });
  const results: Record<string, unknown> = {};
  let current = native;
  try {
    const nativeRun = await exerciseSession(native, false);
    await cliCheck(native);
    await recordRefusals(native);
    current = forward;
    const forwardRun = await exerciseSession(forward, true);
    current = native;
    results.native = nativeRun;
    results.forwarded = forwardRun;
    const traced = "Count native host.check and native job.get lines that logs/serve.log gained during the checks";
    if (nativeRun.dispatch === "native") {
      record(native, { kind: "note", behavior: "host.check native dispatch", surface: "API (guarded proxy)", verdict: "PASS", steps: traced,
        text: `The Rust test-ops session traced native host.check for each of the ${ALIASES.length} checks.` });
    } else {
      record(native, { kind: "note", behavior: "host.check native dispatch", surface: "API (guarded proxy)", verdict: "UNVERIFIED", steps: traced,
        text: "The Rust test-ops session traced no native host.check (native job.get was traced), so host.check is forwarded to the TypeScript core at this revision. Lifecycle and parity evidence covers the forwarded path only." });
    }
    record(forward, { kind: "note", behavior: "host.check forced forwarding", surface: "API (guarded proxy)", verdict: "PASS", steps: traced,
      text: "With PACER_FORWARD_OPS=host.check the service traced no native host.check while native job.get was traced." });
    if (!isDeepStrictEqual(nativeRun.result, forwardRun.result)) {
      writeFileSync(join(native.root, FIXTURE, "difference.json"), JSON.stringify(results, null, 2), { mode: 0o600, flag: "wx" });
      throw Error("host.check results differ between the native and forced-forward sandboxes");
    }
    const parity = `Native (${nativeRun.dispatch}) and forced-forward sandboxes match: replies, settled jobs, host-checks.json entries and public SSE job event sequences, apart from IDs, PIDs and timestamps.`;
    for (const session of [native, forward]) {
      record(session, { kind: "note", behavior: "host.check native/forced-forward parity", surface: "API (guarded proxy)", verdict: "PASS",
        steps: "Compare both sandboxes' normalized results (native-host-effects/results.json in the native sandbox)", text: parity });
    }
    writeFileSync(join(native.root, FIXTURE, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600, flag: "wx" });
  } catch (error) {
    record(current, { kind: "note", behavior: "Native host-effects fixture", surface: "API (guarded proxy)", verdict: "FAIL", text: (error as Error).message });
    throw error;
  }
}
