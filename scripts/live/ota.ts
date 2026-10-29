import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { checkout, liveRoot, loadSession, record, type Session } from "./core";
import { parsePlistDictionary } from "../../src/service";
import { withOtaLedgerLock } from "./ota-lock";
import { exerciseSchema, runtimeSchema, resumableStartup } from "./ota-exercise-record";
import { diagnosticSchema, validateDiagnosticFiles, type FixtureDiagnostics } from "./ota-diagnostics";
import { ownProcessIdentity, sameProcess } from "../../src/update/desktop/process-identity";

/** Scripts-only coordinates; none are production runtime/env options. */
export interface OtaOptions { base?: string; sourceRoot?: string; realHome?: string; platform?: "darwin" | "linux" }
export const OTA_SCENARIOS = ["upgrade", "startup-failure", "helper-crash", "interrupted-install", "restore-failure", "adopt", "adopt-failure", "attached", "wrong-service", "watcher-race", "active-work", "invalid-signature", "corrupt-archive", "wrong-architecture", "incompatible", "offline"] as const;
export const initialLayoutSchema = z.enum(["bridge", "paired"]);
export type InitialLayout = z.infer<typeof initialLayoutSchema>;
/** The published baseline sees only an ordinary nonce; the candidate binds this subfamily to the private record. */
const OLD_SERVICE_CHOICE_NONCE_PREFIX = "f0a3c29e5c0d";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object({ path: z.string(), sha256: hash.nullable() }).strict();
const buildIntent = z.object({ schema: z.literal(1), kind: z.literal("native-build"), buildRoot: z.string(), baselineVersion: z.literal("0.2.3"), candidateVersion: z.literal("0.2.4"), arch: z.enum(["aarch64", "x86_64"]), updaterKeySha256: hash, signingCertSha1: z.string().regex(/^[0-9A-F]{40}$/).optional() }).strict();
const incarnation = z.object({ pid: z.number().int().positive(), bootId: z.string().min(1).max(128), birth: z.string().min(1).max(128) }).strict();
// generations/history are written only by the native ledger when adoption switches the service program.
const registration = z.object({ label: z.string(), path: z.string(), state: z.enum(["reserved", "intent", "loaded", "retired"]), sha256: hash.nullable().default(null), processes: z.array(incarnation).max(128).default([]),
  generations: z.array(hash).min(1).max(2).optional(), history: z.array(z.object({ sha256: hash, state: z.enum(["intent", "loaded", "retired"]), processes: z.array(incarnation).max(128) }).strict()).max(16).optional() }).strict()
  .refine(value => value.state === "reserved" ? value.sha256 === null && value.processes.length === 0 : value.sha256 !== null, "Invalid registration ownership");
const schema = z.object({
  schema: z.literal(1), sessionId: z.string(), root: z.string(), ownerUid: z.number().int(), nonce: z.string().regex(/^[a-f0-9]{32}$/),
  initialLayout: initialLayoutSchema.default("bridge"),
  oldServiceChoice: z.literal("continue").optional(),
  phase: z.enum(["building", "preparing", "prepared", "cleaned"]), pacerHome: z.string(), port: z.number().int(), innerPort: z.number().int(),
  installationId: z.string(), currentApp: z.string(), candidateApp: z.string(), serviceLabel: z.string(), recoveryLabel: z.string(),
  sources: z.tuple([source, source]), registrationBefore: hash.nullable(), registrations: z.tuple([registration, registration]),
  exercise: exerciseSchema.nullable().default(null), runtime: runtimeSchema.nullable().default(null), diagnostics: diagnosticSchema.nullable().default(null), diagnosticProcesses: z.array(incarnation).max(128).default([]), diagnosticsHistory: z.array(diagnosticSchema.extend({ path: z.string(), sourceSha256: hash }).strict()).max(3).default([]),
  processes: z.tuple([]), nativeFixture: buildIntent.nullable(), artifacts: z.array(z.object({ path: z.string(), sha256: hash }).strict()).max(2).default([]),
  external: z.array(z.object({ path: z.string(), sha256: hash }).strict()).max(2).default([]),
}).strict().refine(state => state.phase === "building" ? state.nativeFixture !== null && state.sources.every(source => source.sha256 === null) && state.artifacts.length === 0 : state.sources.every(source => source.sha256 !== null), "Source fingerprints are required outside building").refine(state => (!state.exercise && !state.runtime) || (state.phase === "prepared" || state.phase === "cleaned" && state.runtime?.state === "retired" && (!state.exercise || state.exercise.state === "complete")) && !!state.nativeFixture && !!state.runtime && (!state.exercise || sameProcess(state.exercise.driver, state.runtime.driver)), "Native exercise requires an exact runtime lease");
export type OtaRecord = z.infer<typeof schema>;
/** Fixed initial assembly only; versions never come from a public request. */
export function initialFixtureVersion(state: Pick<OtaRecord, "initialLayout" | "nativeFixture">): "0.2.3" | "0.2.4" {
  const layout = initialLayoutSchema.parse(state.initialLayout ?? "bridge");
  if (state.nativeFixture?.baselineVersion !== "0.2.3" || state.nativeFixture.candidateVersion !== "0.2.4") throw Error("Unknown fixed fixture versions");
  return layout === "paired" ? "0.2.4" : "0.2.3";
}
export function assertFixtureLayoutScenario(state: Pick<OtaRecord, "initialLayout">, scenario: string): void {
  const layout = initialLayoutSchema.parse(state.initialLayout ?? "bridge");
  if (layout === "paired" && scenario !== "adopt" && scenario !== "adopt-failure") throw Error("Paired initial layout is only for adoption scenarios");
}

export function otaFixturePolicy(state: OtaRecord) {
  const cert = state.nativeFixture?.signingCertSha1;
  return { schema: 1 as const, root: state.root, nonce: state.nonce, home: state.pacerHome, port: state.innerPort, currentApp: state.currentApp, serviceLabel: state.serviceLabel, recoveryLabel: state.recoveryLabel, uid: state.ownerUid, ...(cert ? { signingCertSha1: cert } : {}) };
}
/** Reserve compile coordinates only. A building lease grants no runtime capability. */
export function reserveOtaBuild(id: string, arch: "aarch64" | "x86_64", updaterKeySha256: string, options: OtaOptions = {}, signingCertSha1?: string, initialLayout: InitialLayout = "bridge", oldServiceChoice = false): OtaRecord {
  initialLayout = initialLayoutSchema.parse(initialLayout);
  if (oldServiceChoice && initialLayout !== "paired") throw Error("Fixture old-service choice requires paired layout");
  const session = sessionFor(id, options), root = join(session.root, "ota");
  let nonce = oldServiceChoice ? OLD_SERVICE_CHOICE_NONCE_PREFIX + randomBytes(10).toString("hex") : randomBytes(16).toString("hex");
  while (!oldServiceChoice && nonce.startsWith(OLD_SERVICE_CHOICE_NONCE_PREFIX)) nonce = randomBytes(16).toString("hex");
  const nativeFixture = buildIntent.parse({ schema: 1, kind: "native-build", buildRoot: join(root, "build"), baselineVersion: "0.2.3", candidateVersion: "0.2.4", arch, updaterKeySha256, ...(signingCertSha1 ? { signingCertSha1 } : {}) });
  const serviceLabel = `com.pacer.live.${nonce}.service`, recoveryLabel = `com.pacer.live.${nonce}.recovery`;
  const registration = (label: string): OtaRecord["registrations"][number] => ({ label, path: join(root, "registrations", `${label}.plist`), state: "reserved", sha256: null, processes: [] });
  const state: OtaRecord = { schema: 1, sessionId: id, root, nonce, ownerUid: uid(), initialLayout, ...(oldServiceChoice ? { oldServiceChoice: "continue" as const } : {}), phase: "building", pacerHome: join(session.root, "home"), port: session.port, innerPort: session.innerPort!, installationId: `ota-${nonce}`, currentApp: join(root, "current.app"), candidateApp: join(root, "candidate.app"), serviceLabel, recoveryLabel,
    sources: [{ path: join(root, "build/baseline/pacer.app"), sha256: null }, { path: join(root, "build/candidate/pacer.app"), sha256: null }], registrationBefore: registrationDigest(options), registrations: [registration(serviceLabel), registration(recoveryLabel)], processes: [], nativeFixture, artifacts: [], external: [], exercise: null, runtime: null, diagnostics: null, diagnosticsHistory: [], diagnosticProcesses: [] };
  mkdirSync(root, { mode: 0o700 });
  persist(session, state);
  for (const path of [nativeFixture.buildRoot, join(root, "registrations")]) mkdirSync(path, { mode: 0o700 });
  return readOtaRecord(id, options);
}
/** Internal builder boundary. Call only after identities, signatures and archive verification. */
export function finishOtaBuild(id: string, files: { archive: Buffer; feed: Buffer }, options: OtaOptions = {}): void {
  const session = sessionFor(id, options), state = readOtaRecord(id, options);
  if (state.phase !== "building" || !state.nativeFixture || state.registrations.some(item => item.state !== "reserved")) throw Error("Fixture build is not available for finalization");
  unchanged(state, options);
  if (!files.feed.length || files.feed.length > 131072 || !files.archive.length || files.archive.length > 512 * 1024 * 1024) throw Error("Invalid fixture artifact size");
  for (const source of state.sources) source.sha256 = appDigest(source.path);
  for (const [index, target] of [state.currentApp, state.candidateApp].entries()) {
    const sourceIndex = index === 0 && state.initialLayout === "bridge" ? 0 : 1;
    cpSync(state.sources[sourceIndex].path, target, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    if (appDigest(target) !== state.sources[sourceIndex].sha256) throw Error("Fixture copy changed");
  }
  // One external standalone CLI (baseline bytes) for attached/adoption scenarios.
  // A standalone CLI loads its native shim from its own directory.
  mkdirSync(join(state.root, "external"), { mode: 0o700 });
  for (const [from, name, mode] of [["Contents/Resources/pacer", "pacer", 0o700], ["Contents/Frameworks/libpacer-native.dylib", "libpacer-native.dylib", 0o700]] as const) {
    const path = join(state.root, "external", name);
    copyFileSync(join(state.sources[0].path, from), path, constants.COPYFILE_EXCL); chmodSync(path, mode);
    state.external.push({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  }
  syncDirectory(join(state.root, "external"));
  const entries = [[join(state.root, "feed"), "stable.json", files.feed], [join(state.root, "artifacts"), `desktop-pacer-0.2.4-darwin-${state.nativeFixture.arch}.app.tar.gz`, files.archive]] as const;
  for (const [directory, name, bytes] of entries) {
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, name), fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(directory); state.artifacts.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  unchanged(state, options); state.phase = "prepared"; persist(session, state);
  readOtaRecord(id, options);
  record(session, { kind: "note", behavior: "OTA native fixture build", surface: "harness", verdict: "PASS", text: "Exact compile lease finalized with immutable bundle and feed fingerprints. Native installation and service registration have not been exercised." });
}
export type OtaRegistrationObservation = { label: string; sha256: string; loaded: boolean; coverage: "complete" | "unknown"; processes: { pid: number; bootId: string; birth: string }[]; exited: { pid: number; bootId: string; birth: string }[] };
export type OtaRegistrationInspector = (expected: { label: string; path: string; sha256: string; program: string; priorProcesses: { pid: number; bootId: string; birth: string }[] }) => Promise<OtaRegistrationObservation>;
/** Internal fixture-driver boundary: callers supply the native OS inspector, never a public request. */
export function recordOtaRegistrationIntent(id: string, label: string, plist: string, options: OtaOptions = {}): void {
  const session = sessionFor(id, options);
  withOtaLedgerLock(join(session.root, "ota"), () => {
  const state = readOtaRecord(id, options);
  unchanged(state, options);
  const registration = state.registrations.find(item => item.label === label);
  if (state.phase !== "prepared" || !registration || !["reserved", "intent"].includes(registration.state)) throw Error("Registration is not available for a native fixture intent");
  registrationProgram(state, label, plist);
  const digest = createHash("sha256").update(plist).digest("hex");
  if (registration.sha256 !== null && registration.sha256 !== digest) throw Error("Registration intent is immutable");
  registration.sha256 = digest; registration.state = "intent";
  persist(session, state); // Durable ownership precedes any service-manager mutation.
  if (!present(registration.path)) {
    const fd = openSync(registration.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, plist); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(join(state.root, "registrations"));
  }
  readOtaRecord(id, options); // A partially written or substituted plist remains uncertain.
  });
}
export async function observeOtaRegistration(id: string, label: string, next: "loaded" | "retired", inspect: OtaRegistrationInspector, options: OtaOptions = {}): Promise<void> {
  const session = sessionFor(id, options), state = withOtaLedgerLock(join(session.root, "ota"), () => readOtaRecord(id, options)), registration = state.registrations.find(item => item.label === label);
  if (state.phase !== "prepared" || !registration?.sha256 || !["intent", "loaded"].includes(registration.state)) throw Error("Registration has no active native intent");
  const before = JSON.stringify(registration), program = registrationProgram(state, label, readFileSync(registration.path, "utf8"));
  const observed = await inspect({ label, path: registration.path, sha256: registration.sha256, program, priorProcesses: registration.processes.map(process => ({ ...process })) });
  if (observed.label !== label || observed.sha256 !== registration.sha256 || observed.coverage !== "complete") throw Error("Native registration observation is uncertain");
  const processes = z.array(incarnation).max(128).parse(observed.processes), exited = z.array(incarnation).max(128).parse(observed.exited);
  const same = (a: z.infer<typeof incarnation>, b: z.infer<typeof incarnation>) => a.pid === b.pid && a.bootId === b.bootId && a.birth === b.birth;
  if (next === "loaded" && observed.loaded !== true || next === "retired" && (observed.loaded !== false || processes.length || registration.processes.some(process => !exited.some(exit => same(process, exit))))) throw Error("Native job or owned process exit is not proven");
  withOtaLedgerLock(state.root, () => {
  const latest = readOtaRecord(id, options), current = latest.registrations.find(item => item.label === label)!;
  if (JSON.stringify(current) !== before) throw Error("Native registration changed during inspection");
  current.state = next;
  for (const process of processes) if (!current.processes.some(previous => same(previous, process))) current.processes.push(process);
  unchanged(latest, options); persist(session, latest);
  });
  record(session, { kind: "note", behavior: "OTA native registration ownership", surface: "harness", verdict: "PASS", text: next === "retired" ? "Exact fixture job is absent and every recorded process incarnation has exited." : "Exact fixture registration and process incarnations observed; cleanup remains blocked." });
}
const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const uid = () => process.getuid?.() ?? -1;
function inside(parent: string, path: string): boolean { const part = relative(parent, path); return part !== "" && part !== ".." && !part.startsWith("../") && !isAbsolute(part); }
function owned(path: string, kind: "directory" | "file", privateMode = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== uid() || !(kind === "directory" ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) ||
      (privateMode && (stat.mode & 0o077) !== 0)) throw Error("OTA requires an owned, canonical private sandbox resource");
}
function canonical(path: string): string {
  const absolute = resolve(path);
  if (realpathSync(absolute) !== absolute) throw Error("OTA refuses symlinked sandbox paths");
  return absolute;
}
function sessionFor(id: string, options: OtaOptions, allowStopped = false): Session {
  const base = canonical(options.base ?? liveRoot), session = loadSession(id, base);
  canonical(session.root); owned(session.root, "directory", true); owned(join(session.root, "session.json"), "file", true);
  for (const dir of ["home", "evidence"]) { canonical(join(session.root, dir)); owned(join(session.root, dir), "directory", true); }
  const evidence = join(session.root, "evidence/log.jsonl");
  if (present(evidence)) { canonical(evidence); owned(evidence, "file", true); }
  if (!session.innerPort || session.seed || (session.stopped && !allowStopped)) throw Error("OTA requires an unseeded sandbox with separate guarded ports");
  return session;
}
function registrationPath(options: OtaOptions): string {
  const home = options.realHome ?? homedir();
  return (options.platform ?? process.platform) === "darwin" ? join(home, "Library/LaunchAgents/com.pacer.serve.plist") : join(home, ".config/systemd/user/pacer-serve.service");
}
function registrationDigest(options: OtaOptions): string | null {
  const path = registrationPath(options);
  if (!present(path)) return null;
  owned(path, "file");
  if (lstatSync(path).size > 256 * 1024) throw Error("Real registration exceeds inspection limit");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
/** Preserve relative framework symlinks only when they resolve inside this bundle. */
export function appDigest(app: string): string {
  canonical(app); owned(app, "directory");
  const sum = createHash("sha256");
  function walk(path: string): void {
    const stat = lstatSync(path), name = relative(app, path);
    if (stat.uid !== uid()) throw Error("Fixture app contains unowned resources");
    sum.update(JSON.stringify([name, stat.mode & 0o777, stat.isFile() ? stat.size : null]));
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target) || !inside(app, realpathSync(path))) throw Error("Fixture symlink escapes app");
      sum.update("link:" + JSON.stringify(target));
    } else if (stat.isDirectory()) {
      sum.update("dir"); for (const entry of readdirSync(path).sort()) walk(join(path, entry));
    } else if (stat.isFile()) { sum.update("file:"); sum.update(readFileSync(path)); }
    else throw Error("Fixture app contains unsupported resources");
  }
  walk(app); return sum.digest("hex");
}
function sourceApp(path: string, session: Session, options: OtaOptions): { path: string; sha256: string } {
  const app = canonical(path), sourceRoot = realpathSync(options.sourceRoot ?? checkout);
  if (!app.endsWith(".app") || !inside(sourceRoot, app) || inside(session.root, app) || inside(app, session.root) ||
      !existsSync(join(app, "Contents/Info.plist")) || !existsSync(join(app, "Contents/MacOS"))) throw Error("OTA sources must be disposable build bundles outside the sandbox in this checkout");
  return { path: app, sha256: appDigest(app) };
}
const statePath = (session: Session) => join(session.root, "ota/record.json");
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function persist(session: Session, state: OtaRecord): void {
  const path = statePath(session), temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(schema.parse(state), null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); syncDirectory(state.root);
}
function registrationProgram(state: OtaRecord, label: string, text: string): string {
  if (Buffer.byteLength(text) > 131_072) throw Error("Fixture registration exceeds inspection limit");
  const value = parsePlistDictionary(text), args = value.ProgramArguments, env = value.EnvironmentVariables;
  if (value.Label !== label || !Array.isArray(args) || !args.length || args.length > 8 || !args.every(arg => typeof arg === "string" && arg.length > 0 && arg.length <= 4096 && !/[\0\r\n]/.test(arg)) ||
      !env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).some(key => !["HOME", "PATH", "PACER_HOME", "PACER_PORT"].includes(key)) ||
      Object.values(env).some(value => typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value)) ||
      env.HOME !== state.pacerHome || env.PACER_HOME !== undefined && env.PACER_HOME !== state.pacerHome ||
      env.PACER_PORT !== undefined && env.PACER_PORT !== String(state.innerPort) || typeof value.KeepAlive !== "boolean" || typeof value.RunAtLoad !== "boolean" ||
      Object.keys(value).some(key => !["Label", "ProgramArguments", "EnvironmentVariables", "KeepAlive", "RunAtLoad", "ThrottleInterval", "ProcessType", "StandardOutPath", "StandardErrorPath"].includes(key))) throw Error("Fixture registration is not owned by this lease");
  const program = canonical(args[0] as string);
  const external = state.external.length && label === state.serviceLabel && program === join(state.root, "external/pacer");
  if (!external && !inside(state.currentApp, program) && !inside(state.candidateApp, program) && !inside(join(state.pacerHome, "desktop-updates/native", state.exercise?.installationId ?? state.installationId), program)) throw Error("Fixture registration executable escapes the lease");
  owned(program, "file");
  for (const key of ["StandardOutPath", "StandardErrorPath"]) if (value[key] !== undefined) throw Error("Fixture probes must use inherited null output");
  return program;
}
function unchanged(state: OtaRecord, options: OtaOptions): void {
  for (const source of state.sources) if (source.sha256 !== null && appDigest(source.path) !== source.sha256) throw Error("OTA source app changed; preserving evidence for diagnosis");
  if (registrationDigest(options) !== state.registrationBefore) throw Error("Real service registration changed; refusing cleanup or exercise");
}
export function readOtaRecord(id: string, options: OtaOptions = {}): OtaRecord {
  const session = sessionFor(id, options, true), root = join(session.root, "ota");
  canonical(root); owned(root, "directory", true); owned(statePath(session), "file", true);
  if (lstatSync(statePath(session)).size > 262_144) throw Error("OTA resource record exceeds inspection limit");
  const state = schema.parse(JSON.parse(readFileSync(statePath(session), "utf8")));
  if (state.nativeFixture && (state.oldServiceChoice === "continue") !== state.nonce.startsWith(OLD_SERVICE_CHOICE_NONCE_PREFIX)) throw Error("Fixture old-service choice differs from compiled nonce");
  if (state.oldServiceChoice && state.initialLayout !== "paired") throw Error("Fixture old-service choice requires paired layout");
  const prefix = `com.pacer.live.${state.nonce}`;
  if (state.sessionId !== id || state.root !== root || state.ownerUid !== uid() || state.pacerHome !== join(session.root, "home") ||
      state.port !== session.port || state.innerPort !== session.innerPort || state.installationId !== `ota-${state.nonce}` ||
      state.currentApp !== join(root, "current.app") || state.candidateApp !== join(root, "candidate.app") ||
      state.serviceLabel !== `${prefix}.service` || state.recoveryLabel !== `${prefix}.recovery`) throw Error("OTA record targets an unowned identity");
  for (const [index, label] of [state.serviceLabel, state.recoveryLabel].entries()) {
    if (state.registrations[index].label !== label || state.registrations[index].path !== join(root, "registrations", `${label}.plist`)) throw Error("OTA record targets an unowned registration");
  }
  if (state.nativeFixture) {
    if (state.nativeFixture.buildRoot !== join(root, "build")) throw Error("Invalid fixture build root");
    canonical(state.nativeFixture.buildRoot); owned(state.nativeFixture.buildRoot, "directory", true);
    for (const [index, source] of state.sources.entries()) {
      if (source.path !== join(root, "build", index === 0 ? "baseline" : "candidate", "pacer.app")) throw Error("Invalid reserved build source");
      if (source.sha256 !== null && appDigest(source.path) !== source.sha256) throw Error("OTA source changed");
    }
  } else for (const app of state.sources) if (sourceApp(app.path, session, options).sha256 !== app.sha256) throw Error("OTA source changed");
  for (const app of [state.currentApp, state.candidateApp]) if (present(app)) appDigest(app);
  for (const name of readdirSync(root)) if (!["record.json", "current.app", "candidate.app", "registrations", "locks", ...(state.nativeFixture ? ["build", "feed", "artifacts", ...(state.external.length ? ["external"] : [])] : []), ...(state.diagnostics ? ["diagnostics"] : [])].includes(name)) throw Error("OTA contains unrecorded resources");
  if (state.diagnostics) {
    if (!state.nativeFixture || !["prepared", "cleaned"].includes(state.phase)) throw Error("Diagnostics require a finalized native fixture");
    validateDiagnosticFiles(join(root, "diagnostics"), state.diagnostics, createHash("sha256").update(JSON.stringify(otaFixturePolicy(state))).digest("hex"));
  }
  if (state.diagnosticsHistory.length && !state.diagnostics) throw Error("Diagnostic history requires a current descriptor");
  for (const [index, entry] of state.diagnosticsHistory.entries()) {
    const { path, sourceSha256: _source, ...descriptor } = entry;
    if (path !== join(root, "build/diagnostics", `attempt-${index + 1}`)) throw Error("Diagnostic history path differs");
    validateDiagnosticFiles(path, descriptor, createHash("sha256").update(JSON.stringify(otaFixturePolicy(state))).digest("hex"));
  }
  const locks = join(root, "locks");
  if (present(locks)) {
    canonical(locks); owned(locks, "directory", true);
    const names = readdirSync(locks);
    if (names.length > 32) throw Error("Too many fixture locks");
    for (const name of names) {
      if (name !== "ledger-lock" && !/^(app|home)-[a-f0-9]{64}$/.test(name)) throw Error("Unknown fixture lock");
      canonical(join(locks, name)); owned(join(locks, name), "file", true);
      if (lstatSync(join(locks, name)).size > 1024) throw Error("Oversized fixture lock");
    }
  }
  for (const directory of ["feed", "artifacts"]) {
    const path = join(root, directory);
    const expected = directory === "feed" ? "stable.json" : `desktop-pacer-0.2.4-darwin-${state.nativeFixture?.arch}.app.tar.gz`;
    for (const asset of state.artifacts.filter(asset => asset.path.startsWith(path + "/"))) if (asset.path !== join(path, expected)) throw Error("Invalid artifact identity");
    if (present(path)) {
      canonical(path); owned(path, "directory", true);
      for (const name of readdirSync(path)) {
        const file = join(path, name), asset = state.artifacts.find(asset => asset.path === file);
        if (name !== expected || !asset) throw Error("Unrecorded fixture artifact");
        canonical(file); owned(file, "file", true);
        if (lstatSync(file).size > (directory === "feed" ? 131072 : 512 * 1024 * 1024) || createHash("sha256").update(readFileSync(file)).digest("hex") !== asset.sha256) throw Error("Fixture artifact changed");
      }
    } else if (state.phase === "prepared" && state.artifacts.some(asset => asset.path.startsWith(path + "/"))) throw Error("Fixture artifact missing");
  }
  if (state.nativeFixture && state.phase === "prepared" && (state.artifacts.length !== 2 || state.artifacts.some(asset => !present(asset.path)))) throw Error("Fixture artifacts missing");
  if (state.artifacts.some(asset => asset.path !== join(root, "feed/stable.json") && asset.path !== join(root, "artifacts", `desktop-pacer-0.2.4-darwin-${state.nativeFixture?.arch}.app.tar.gz`)) || new Set(state.artifacts.map(asset => asset.path)).size !== state.artifacts.length) throw Error("Invalid fixture artifact ledger");
  const externalFiles = [join(root, "external/pacer"), join(root, "external/libpacer-native.dylib")];
  if (state.external.length && (!state.nativeFixture || state.external.length !== 2 || state.external.some((file, index) => file.path !== externalFiles[index]))) throw Error("Invalid external service ledger");
  if (present(join(root, "external"))) {
    if (!state.external.length) throw Error("Unrecorded external service");
    canonical(join(root, "external")); owned(join(root, "external"), "directory", true);
    if (readdirSync(join(root, "external")).sort().join() !== "libpacer-native.dylib,pacer") throw Error("Unrecorded external service resource");
    for (const file of state.external) {
      canonical(file.path); owned(file.path, "file", true);
      if (lstatSync(file.path).size > 512 * 1024 * 1024 || createHash("sha256").update(readFileSync(file.path)).digest("hex") !== file.sha256) throw Error("External service changed");
    }
  } else if (state.phase === "prepared" && state.external.length) throw Error("External service missing");
  const registrations = join(root, "registrations");
  if (present(registrations)) {
    canonical(registrations); owned(registrations, "directory", true);
    for (const name of readdirSync(registrations)) {
      const registration = state.registrations.find(item => item.path === join(registrations, name));
      if (!registration?.sha256 || registration.state === "reserved") throw Error("OTA registration has no verified fixture owner");
      canonical(registration.path); owned(registration.path, "file", true);
      if (lstatSync(registration.path).size > 131_072) throw Error("Fixture registration exceeds inspection limit");
      const text = readFileSync(registration.path, "utf8");
      if (createHash("sha256").update(text).digest("hex") !== registration.sha256) throw Error("Fixture registration bytes changed");
      registrationProgram(state, registration.label, text);
    }
  }
  return state;
}
export async function prepareOta(id: string, fromApp: string, toApp: string, options: OtaOptions = {}): Promise<void> {
  const session = sessionFor(id, options), sources: OtaRecord["sources"] = [sourceApp(fromApp, session, options), sourceApp(toApp, session, options)];
  if (sources[0].path === sources[1].path || inside(sources[0].path, sources[1].path) || inside(sources[1].path, sources[0].path)) throw Error("OTA requires separate source bundles");
  const registrationBefore = registrationDigest(options), root = join(session.root, "ota"), nonce = randomBytes(16).toString("hex");
  const serviceLabel = `com.pacer.live.${nonce}.service`, recoveryLabel = `com.pacer.live.${nonce}.recovery`;
  const reserved = (label: string): OtaRecord["registrations"][number] => ({ label, path: join(root, "registrations", `${label}.plist`), state: "reserved", sha256: null, processes: [] });
  const state: OtaRecord = { schema: 1, sessionId: id, root, ownerUid: uid(), nonce, initialLayout: "bridge", phase: "preparing", pacerHome: join(session.root, "home"),
    port: session.port, innerPort: session.innerPort!, installationId: `ota-${nonce}`, currentApp: join(root, "current.app"), candidateApp: join(root, "candidate.app"),
    serviceLabel, recoveryLabel, sources, registrationBefore, registrations: [reserved(serviceLabel), reserved(recoveryLabel)],
    processes: [], nativeFixture: null, artifacts: [], external: [], exercise: null, runtime: null, diagnostics: null, diagnosticsHistory: [], diagnosticProcesses: [] };
  mkdirSync(root, { mode: 0o700 }); // Exclusive ownership; never overwrite a previous sandbox transaction.
  persist(session, state); // Record intent before any app copy or future registration.
  mkdirSync(join(root, "registrations"), { mode: 0o700 });
  for (const [index, destination] of [state.currentApp, state.candidateApp].entries()) {
    cpSync(sources[index].path, destination, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    if (appDigest(destination) !== sources[index].sha256) throw Error("Copied OTA fixture does not match its source");
  }
  unchanged(state, options); state.phase = "prepared"; persist(session, state);
  record(session, { kind: "note", behavior: "OTA fixture preparation", surface: "harness", verdict: "PASS", text: "Disposable app copies verified; source fingerprints and real registration bytes unchanged. No service-manager calls or native launches." });
}
export async function cleanupOta(id: string, options: OtaOptions = {}): Promise<void> {
  const session = sessionFor(id, options, true);
  const initial = readOtaRecord(id, options);
  if (initial.runtime && initial.runtime.state !== "retired") {
    if (initial.exercise?.state !== "complete") throw Error("Unresolved native exercise retained for diagnosis");
    const { inspectFixtureJobs } = await import("./ota-native");
    const { incarnationExited } = await import("./ota-exercise");
    const observed = await inspectFixtureJobs(initial, true);
    if (observed.desktops.length || observed.jobs.some(job => job.loaded || !["reserved", "retired"].includes(job.state)) || !incarnationExited(initial.runtime.sourceService) || initial.runtime.desktop && !incarnationExited(initial.runtime.desktop)) throw Error("Owned native process exit remains unproven");
    withOtaLedgerLock(initial.root, () => {
      const latest = readOtaRecord(id, options);
      if (JSON.stringify(latest.runtime) !== JSON.stringify(initial.runtime) || JSON.stringify(latest.exercise) !== JSON.stringify(initial.exercise)) throw Error("Fixture runtime changed during retirement");
      latest.runtime!.state = "retired"; latest.runtime!.request = null;
      unchanged(latest, options); persist(session, latest);
    });
  }
  withOtaLedgerLock(join(session.root, "ota"), () => {
  const state = readOtaRecord(id, options);
  unchanged(state, options);
  if (state.runtime && state.runtime.state !== "retired" || state.exercise?.state === "failed") throw Error("Native exercise ownership or failed recovery retained for diagnosis");
  if (state.phase === "building") throw Error("Incomplete fixture build retained for diagnosis");
  if (state.registrations.some(registration => registration.state === "intent" || registration.state === "loaded")) throw Error("OTA registration is active or uncertain; preserving all evidence");
  for (const app of [state.currentApp, state.candidateApp]) if (present(app)) rmSync(app, { recursive: true });
  const registrations = join(state.root, "registrations");
  if (present(registrations)) rmSync(registrations, { recursive: true });
  for (const directory of ["feed", "artifacts", "external"]) if (present(join(state.root, directory))) rmSync(join(state.root, directory), { recursive: true });
  unchanged(state, options); state.phase = "cleaned"; persist(session, state);
  });
  record(session, { kind: "note", behavior: "OTA fixture cleanup", surface: "harness", verdict: "PASS", text: initial.runtime ? "Native participants retired through the fixed lease-bound helper; only recorded disposable copies removed. Source fingerprints, sandbox user data and real registration bytes unchanged." : "Only recorded disposable copies removed; source fingerprints and real registration bytes unchanged. No service-manager calls or native launches." });
}
export async function exerciseOta(id: string, scenario: string, options: OtaOptions = {}): Promise<void> {
  if (!(OTA_SCENARIOS as readonly string[]).includes(scenario)) throw Error("Unsupported OTA scenario");
  const session = sessionFor(id, options), state = readOtaRecord(id, options);
  if (state.phase !== "prepared") throw Error("OTA fixtures are not prepared");
  unchanged(state, options);
  assertFixtureLayoutScenario(state, scenario);
  if (state.nativeFixture) {
    try {
      const { ATTACHED_SCENARIOS } = await import("./ota-exercise-record");
      if ((ATTACHED_SCENARIOS as readonly string[]).includes(scenario)) return await (await import("./ota-adoption")).runAttachedExercise(id, scenario, options);
      return await (await import("./ota-exercise")).runManagedExercise(id, scenario, options);
    }
    catch (error) {
      record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "desktop", verdict: "UNVERIFIED", text: error instanceof Error ? error.message : "Native exercise outcome not established; evidence retained" });
      throw error;
    }
  }
  // Fail closed until a separately built native fixture adapter verifies its compile-time identity.
  record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "desktop", verdict: "UNVERIFIED", text: "Native test-build fixture adapter is unavailable; D3/D8 remain active. No update, service-manager call or native launch was attempted." });
  throw Error("UNVERIFIED: native OTA fixture adapter is unavailable");
}

/** Reclaim only an exited, never-armed startup; retain its identities in evidence. */
export async function resumeOtaStartup(id: string, expected: OtaRecord, options: OtaOptions = {}): Promise<OtaRecord> {
  const session = sessionFor(id, options), own = ownProcessIdentity();
  const { incarnationExited } = await import("./ota-exercise");
  if (!own || expected.root !== join(session.root, "ota")) throw Error("Current driver identity or fixture root unavailable");
  return withOtaLedgerLock(expected.root, () => {
    const state = readOtaRecord(id, options);
    if (state.phase !== "prepared" || !state.nativeFixture || JSON.stringify(state.runtime) !== JSON.stringify(expected.runtime) || !resumableStartup(state.runtime, state.exercise, incarnationExited)) throw Error("Previous startup ownership is unresolved");
    unchanged(state, options);
    const previous = state.runtime!;
    state.runtime = { ...previous, driver: own, desktop: null };
    persist(session, state);
    record(session, { kind: "note", behavior: "Retry never-armed native baseline", surface: "harness", text: JSON.stringify({ previous, driver: own, previousParticipantsExited: true }) });
    return state;
  });
}

/** Internal driver CAS; never a public capability or arbitrary native command. */
export function updateOtaDriverRecord(id: string, expected: Pick<OtaRecord, "runtime" | "exercise">, next: Pick<OtaRecord, "runtime" | "exercise">, options: OtaOptions = {}): OtaRecord {
  if ("initialLayout" in next) throw Error("Initial layout is immutable to the runtime driver");
  const session = sessionFor(id, options), own = ownProcessIdentity();
  if (!own || !next.runtime || !sameProcess(own, next.runtime.driver)) throw Error("Only the exact live fixture driver may update its lease");
  return withOtaLedgerLock(join(session.root, "ota"), () => {
    const state = readOtaRecord(id, options);
    if (state.phase !== "prepared" || !state.nativeFixture || JSON.stringify({ runtime: state.runtime, exercise: state.exercise }) !== JSON.stringify({ runtime: expected.runtime, exercise: expected.exercise }) || state.runtime && !sameProcess(state.runtime.driver, own)) throw Error("Fixture driver lease changed");
    if (state.exercise && (!next.exercise || state.exercise.installationId !== next.exercise.installationId || state.exercise.scenario !== next.exercise.scenario || state.exercise.transactionId !== next.exercise.transactionId || JSON.stringify(state.exercise.faults) !== JSON.stringify(next.exercise.faults))) throw Error("Native exercise binding and consumption are immutable to the driver");
    unchanged(state, options);
    state.runtime = next.runtime; state.exercise = next.exercise; persist(session, state);
    return state;
  });
}

/** Finalize exactly two signed, compiled cleanup diagnostics from the fixed build staging path. */
export function recordOtaDiagnostics(id: string, descriptor: FixtureDiagnostics, options: OtaOptions = {}): void {
  const session = sessionFor(id, options);
  withOtaLedgerLock(join(session.root, "ota"), () => {
    const state = readOtaRecord(id, options);
    // Cleanup diagnostics are signed ad hoc after the build; a certificate-pinned lease would refuse them.
    if (state.nativeFixture?.signingCertSha1) throw Error("Cleanup diagnostics are unavailable for certificate-signed fixtures");
    if (state.phase !== "prepared" || !state.nativeFixture || state.diagnostics || state.exercise || state.runtime?.state !== "starting" || state.runtime.request !== null) throw Error("Diagnostics require an unresolved, never-armed native startup");
    const stage = join(state.nativeFixture.buildRoot, "diagnostics/stage");
    const expected = diagnosticSchema.parse(descriptor);
    validateDiagnosticFiles(stage, expected, createHash("sha256").update(JSON.stringify(otaFixturePolicy(state))).digest("hex"));
    if (present(join(state.root, "diagnostics"))) throw Error("Diagnostics already exist");
    unchanged(state, options);
    state.diagnostics = expected;
    persist(session, state); // The immutable descriptor precedes executable availability.
    renameSync(stage, join(state.root, "diagnostics")); syncDirectory(state.root);
    readOtaRecord(id, options);
  });
}

/** Fixed failed-startup retirement; no user-selected manager, process, or command. */
export async function retireFailedOtaStartup(id: string, options: OtaOptions = {}): Promise<void> {
  const session = sessionFor(id, options), initial = readOtaRecord(id, options);
  const { retireFixtureStartupJobs } = await import("./ota-native");
  const { incarnationExited } = await import("./ota-exercise");
  const { assertStartupRetirement } = await import("./ota-diagnostics");
  if (!initial.runtime?.desktop || [initial.runtime.driver, initial.runtime.sourceService, initial.runtime.desktop].some(process => !incarnationExited(process))) throw Error("Failed-startup participants must first exit gracefully");
  const observed = await retireFixtureStartupJobs(initial);
  assertStartupRetirement(initial, observed, incarnationExited);
  withOtaLedgerLock(initial.root, () => {
    const latest = readOtaRecord(id, options);
    if (JSON.stringify(latest.runtime) !== JSON.stringify(initial.runtime) || JSON.stringify(latest.exercise) !== JSON.stringify(initial.exercise) || JSON.stringify(latest.diagnostics) !== JSON.stringify(initial.diagnostics)) throw Error("Fixture startup evidence changed during retirement");
    assertStartupRetirement(latest, observed, incarnationExited);
    if (latest.registrations.some(row => !["reserved", "retired"].includes(row.state))) throw Error("Native registration retirement is not durable");
    unchanged(latest, options); latest.runtime!.state = "retired"; persist(session, latest);
  });
  record(session, { kind: "note", behavior: "Failed fixture baseline service retirement", surface: "native service", verdict: "PASS", text: "Signed fixed diagnostic reserved idle admission, retired only the exact scoped job, and proved every recorded participant incarnation exited. No OTA transaction was armed." });
}

/** Preserve each prior fixed diagnostic attempt before installing its audited correction. */
export async function replaceOtaDiagnostics(id: string, descriptor: FixtureDiagnostics, options: OtaOptions = {}): Promise<void> {
  const session = sessionFor(id, options);
  const { enumerateNativeProcesses } = await import("../../src/update/desktop/native-os");
  const { incarnationExited, privateFixtureBytes } = await import("./ota-exercise");
  withOtaLedgerLock(join(session.root, "ota"), () => {
    const state = readOtaRecord(id, options);
    if (state.phase !== "prepared" || !state.nativeFixture || !state.diagnostics || state.diagnosticsHistory.length >= 3 || state.exercise || state.runtime?.state !== "starting" || state.runtime.request !== null || !state.runtime.desktop) throw Error("Diagnostic replacement is unavailable");
    if ([state.runtime.driver, state.runtime.sourceService, state.runtime.desktop].some(process => !incarnationExited(process))) throw Error("Startup participant exit is unproven");
    if (state.diagnosticProcesses.some(process => !incarnationExited(process)) || enumerateNativeProcesses().some(process => process.executable?.startsWith(join(state.root, "diagnostics") + "/"))) throw Error("Diagnostic process exit is unproven");
    const directory = join(state.nativeFixture.buildRoot, "diagnostics"), index = state.diagnosticsHistory.length + 1;
    const metadata = JSON.parse(privateFixtureBytes(join(directory, index === 1 ? "source-captured.json" : `source-captured-${index}.json`), 4096).toString("utf8"));
    const sourceSha256 = hash.parse(metadata.sourceSha256), expected = diagnosticSchema.parse(descriptor);
    const stage = join(directory, "stage"), archive = join(directory, `attempt-${index}`);
    validateDiagnosticFiles(stage, expected, createHash("sha256").update(JSON.stringify(otaFixturePolicy(state))).digest("hex"));
    if (present(archive)) throw Error("Diagnostic history already exists");
    unchanged(state, options);
    renameSync(join(state.root, "diagnostics"), archive); syncDirectory(directory); syncDirectory(state.root);
    state.diagnosticsHistory.push({ ...state.diagnostics, path: archive, sourceSha256 }); state.diagnostics = expected;
    persist(session, state);
    renameSync(stage, join(state.root, "diagnostics")); syncDirectory(state.root);
    readOtaRecord(id, options);
  });
}

/** Track only an observed direct child at one of the two immutable diagnostic paths. */
export async function recordOtaDiagnosticProcess(id: string, expected: z.infer<typeof incarnation>, options: OtaOptions = {}): Promise<void> {
  const session = sessionFor(id, options);
  const { enumerateNativeProcesses } = await import("../../src/update/desktop/native-os");
  const observed = enumerateNativeProcesses().find(candidate => candidate.process.pid === expected.pid);
  withOtaLedgerLock(join(session.root, "ota"), () => {
    const state = readOtaRecord(id, options);
    if (!state.diagnostics || !observed || !sameProcess(observed.process, expected) || observed.parentPid !== process.pid || ![join(state.root, "diagnostics/pacer-startup-cleanup"), join(state.root, "diagnostics/pacer-update-helper")].includes(observed.executable ?? "")) throw Error("Diagnostic child identity is unproven");
    if (!state.diagnosticProcesses.some(prior => sameProcess(prior, expected))) state.diagnosticProcesses.push(expected);
    persist(session, state);
  });
}
