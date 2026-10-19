import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { atomicWrite, checkout, liveRoot, loadSession, record, type Session } from "./core";

/** Scripts-only coordinates; none are production runtime/env options. */
export interface OtaOptions { base?: string; sourceRoot?: string; realHome?: string; platform?: "darwin" | "linux" }
export const OTA_SCENARIOS = ["upgrade", "startup-failure", "helper-crash", "interrupted-install", "restore-failure", "adopt", "adopt-failure", "attached", "wrong-service", "watcher-race", "active-work", "invalid-signature", "corrupt-archive", "wrong-architecture", "incompatible", "offline"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object({ path: z.string(), sha256: hash }).strict();
const registration = z.object({ label: z.string(), path: z.string(), state: z.literal("reserved") }).strict();
const schema = z.object({
  schema: z.literal(1), sessionId: z.string(), root: z.string(), ownerUid: z.number().int(), nonce: z.string().regex(/^[a-f0-9]{32}$/),
  phase: z.enum(["preparing", "prepared", "cleaned"]), pacerHome: z.string(), port: z.number().int(), innerPort: z.number().int(),
  installationId: z.string(), currentApp: z.string(), candidateApp: z.string(), serviceLabel: z.string(), recoveryLabel: z.string(),
  sources: z.tuple([source, source]), registrationBefore: hash.nullable(), registrations: z.tuple([registration, registration]),
  processes: z.tuple([]), nativeFixture: z.null(),
}).strict();
export type OtaRecord = z.infer<typeof schema>;
const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const uid = () => process.getuid?.() ?? -1;
function inside(parent: string, path: string): boolean { const part = relative(parent, path); return part !== "" && part !== ".." && !part.startsWith("../") && !isAbsolute(part); }
function owned(path: string, kind: "directory" | "file", privateMode = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== uid() || !(kind === "directory" ? stat.isDirectory() : stat.isFile()) ||
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
function persist(session: Session, state: OtaRecord): void { atomicWrite(statePath(session), JSON.stringify(schema.parse(state), null, 2) + "\n"); }
function unchanged(state: OtaRecord, options: OtaOptions): void {
  for (const source of state.sources) if (appDigest(source.path) !== source.sha256) throw Error("OTA source app changed; preserving evidence for diagnosis");
  if (registrationDigest(options) !== state.registrationBefore) throw Error("Real service registration changed; refusing cleanup or exercise");
}
export function readOtaRecord(id: string, options: OtaOptions = {}): OtaRecord {
  const session = sessionFor(id, options, true), root = join(session.root, "ota");
  canonical(root); owned(root, "directory", true); owned(statePath(session), "file", true);
  const state = schema.parse(JSON.parse(readFileSync(statePath(session), "utf8")));
  const prefix = `com.pacer.live.${state.nonce}`;
  if (state.sessionId !== id || state.root !== root || state.ownerUid !== uid() || state.pacerHome !== join(session.root, "home") ||
      state.port !== session.port || state.innerPort !== session.innerPort || state.installationId !== `ota-${state.nonce}` ||
      state.currentApp !== join(root, "current.app") || state.candidateApp !== join(root, "candidate.app") ||
      state.serviceLabel !== `${prefix}.service` || state.recoveryLabel !== `${prefix}.recovery`) throw Error("OTA record targets an unowned identity");
  for (const [index, label] of [state.serviceLabel, state.recoveryLabel].entries()) {
    if (state.registrations[index].label !== label || state.registrations[index].path !== join(root, "registrations", `${label}.plist`)) throw Error("OTA record targets an unowned registration");
  }
  for (const app of state.sources) if (sourceApp(app.path, session, options).sha256 !== app.sha256) throw Error("OTA source changed");
  for (const app of [state.currentApp, state.candidateApp]) if (present(app)) appDigest(app);
  for (const name of readdirSync(root)) if (!["record.json", "current.app", "candidate.app", "registrations"].includes(name)) throw Error("OTA contains unrecorded resources");
  const registrations = join(root, "registrations");
  if (present(registrations)) {
    canonical(registrations); owned(registrations, "directory", true);
    // No manager registration is enabled until Task 8 supplies the compile-time fixture adapter.
    if (readdirSync(registrations).length) throw Error("OTA registration has no verified fixture owner");
  }
  return state;
}
export async function prepareOta(id: string, fromApp: string, toApp: string, options: OtaOptions = {}): Promise<void> {
  const session = sessionFor(id, options), sources: OtaRecord["sources"] = [sourceApp(fromApp, session, options), sourceApp(toApp, session, options)];
  if (sources[0].path === sources[1].path || inside(sources[0].path, sources[1].path) || inside(sources[1].path, sources[0].path)) throw Error("OTA requires separate source bundles");
  const registrationBefore = registrationDigest(options), root = join(session.root, "ota"), nonce = randomBytes(16).toString("hex");
  const serviceLabel = `com.pacer.live.${nonce}.service`, recoveryLabel = `com.pacer.live.${nonce}.recovery`;
  const state: OtaRecord = { schema: 1, sessionId: id, root, ownerUid: uid(), nonce, phase: "preparing", pacerHome: join(session.root, "home"),
    port: session.port, innerPort: session.innerPort!, installationId: `ota-${nonce}`, currentApp: join(root, "current.app"), candidateApp: join(root, "candidate.app"),
    serviceLabel, recoveryLabel, sources, registrationBefore, registrations: [serviceLabel, recoveryLabel].map(label => ({ label, path: join(root, "registrations", `${label}.plist`), state: "reserved" as const })) as OtaRecord["registrations"],
    processes: [], nativeFixture: null };
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
  const session = sessionFor(id, options, true), state = readOtaRecord(id, options);
  unchanged(state, options);
  for (const app of [state.currentApp, state.candidateApp]) if (present(app)) rmSync(app, { recursive: true });
  const registrations = join(state.root, "registrations");
  if (present(registrations)) rmSync(registrations, { recursive: true });
  unchanged(state, options); state.phase = "cleaned"; persist(session, state);
  record(session, { kind: "note", behavior: "OTA fixture cleanup", surface: "harness", verdict: "PASS", text: "Only recorded disposable copies removed; source fingerprints and real registration bytes unchanged. No service-manager calls or native launches." });
}
export async function exerciseOta(id: string, scenario: string, options: OtaOptions = {}): Promise<void> {
  if (!(OTA_SCENARIOS as readonly string[]).includes(scenario)) throw Error("Unsupported OTA scenario");
  const session = sessionFor(id, options), state = readOtaRecord(id, options);
  if (state.phase !== "prepared") throw Error("OTA fixtures are not prepared");
  unchanged(state, options);
  // Fail closed until a separately built native fixture adapter verifies its compile-time identity.
  record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "desktop", verdict: "UNVERIFIED", text: "Native test-build fixture adapter is unavailable; D3/D8 remain active. No update, service-manager call or native launch was attempted." });
  throw Error("UNVERIFIED: native OTA fixture adapter is unavailable");
}
