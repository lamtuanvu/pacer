/** Fixed native fixture diagnostics. No caller-provided executable or manager argument. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { appDigest, otaFixturePolicy, recordOtaDiagnosticProcess, type OtaRecord } from "./ota";
import { fixtureProcessSchema } from "./ota-exercise-record";
import { installationFingerprint } from "../../src/update/desktop/identity";
import { processIdentity } from "../../src/update/desktop/process-identity";
import type { Installation } from "../../src/update/desktop/types";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const jobSchema = z.object({ label: z.string(), state: z.enum(["reserved", "intent", "loaded", "retired"]), loaded: z.boolean(), process: fixtureProcessSchema.nullable(), executable: z.string().nullable(), registrationSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), registrationText: z.string().max(131072).nullable() }).strict();
export const jobsSchema = z.object({ schema: z.literal(1), jobs: z.array(jobSchema).max(2), desktops: z.array(fixtureProcessSchema).max(128) }).strict();
export type FixtureJobs = z.infer<typeof jobsSchema>;
export function validateFixtureIdentity(state: OtaRecord, value: unknown, role: "cli" | "helper" | "desktop", version: string): void {
  const identity = z.object({ schema: z.literal(1), role: z.literal(role === "helper" ? "update-helper" : role), bundleId: z.literal(role === "cli" ? "dev.pacer.cli" : "dev.pacer.desktop"), version: z.literal(version), arch: z.literal(state.nativeFixture!.arch), fixture: z.literal(true), otaMode: z.literal("fixture"), fixturePolicySha256: z.literal(digest(JSON.stringify(otaFixturePolicy(state)))), updaterKeySha256: z.string().optional(), fixtureIsolationProtocol: z.number().optional() }).parse(value);
  if (role === "desktop" && identity.fixtureIsolationProtocol !== 1) throw Error("Fixture shell lacks compiled isolation proof");
  if (role !== "cli" && identity.updaterKeySha256 !== state.nativeFixture!.updaterKeySha256) throw Error("Fixture updater key differs from its lease");
}
/** The lease's only external service program; Desktop sees it as attached. */
export const fixtureExternalCli = (state: Pick<OtaRecord, "root">) => join(state.root, "external/pacer");
/** Ownership follows the exact registered program: the bundled CLI is managed, the lease's external CLI is attached. */
export function fixtureInstallation(state: OtaRecord, observed: unknown, version: string, ownership?: Installation["ownership"]): Installation {
  const report = jobsSchema.parse(observed), service = report.jobs.find(job => job.label === state.serviceLabel);
  const bundled = join(state.currentApp, "Contents/Resources/pacer"), external = fixtureExternalCli(state);
  if (!service || report.jobs.filter(job => job.label === state.serviceLabel).length !== 1 || !service.loaded || service.state !== "loaded" || !service.process || (service.executable !== bundled && service.executable !== external) || !service.registrationText || digest(service.registrationText) !== service.registrationSha256) throw Error("Exact fixture service is not proven");
  const actual = service.executable === bundled ? "managed" as const : "attached" as const;
  if (ownership && ownership !== actual) throw Error(`Fixture service is ${actual}, not ${ownership}`);
  const identity: Omit<Installation, "id" | "version"> = { appPath: state.currentApp, bundleId: "dev.pacer.desktop", ownerUid: state.ownerUid, arch: state.nativeFixture!.arch, pacerHome: state.pacerHome, port: state.innerPort, serviceLabel: state.serviceLabel, ownership: actual };
  return { ...identity, id: installationFingerprint(identity, service.executable, service.registrationText), version };
}
export function fixtureEnvironment(state: OtaRecord): Record<string, string> {
  return { HOME: state.pacerHome, PACER_HOME: state.pacerHome, PACER_PORT: String(state.innerPort), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
}
async function run(state: OtaRecord, argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { env: fixtureEnvironment(state), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 });
  let identityError: unknown;
  if (argv[0].startsWith(join(state.root, "diagnostics") + "/") && argv[1] === "--ota-fixture-retire") {
    const observed = processIdentity(child.pid);
    if (observed) try { await recordOtaDiagnosticProcess(state.sessionId, observed); } catch (error) { identityError = error; }
  }
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (identityError) throw identityError;
  if (Buffer.byteLength(stdout) > 524288 || Buffer.byteLength(stderr) > 524288) throw Error("Native fixture diagnostic exceeded its bounded output");
  if (code !== 0) throw Error(`Native fixture diagnostic refused (exit ${code}): ${stderr.trim().slice(0, 2048)}`);
  return stdout;
}
function knownFixtureBytes(state: OtaRecord, version?: string): void {
  if (state.phase !== "prepared" || !state.nativeFixture) throw Error("Prepared native fixture required");
  const hashes = version === undefined ? state.sources.map(source => source.sha256) : version === state.nativeFixture.baselineVersion ? [state.sources[0].sha256] : version === state.nativeFixture.candidateVersion ? [state.sources[1].sha256] : [];
  if (!hashes.includes(appDigest(state.currentApp))) throw Error("Fixture bundle bytes differ from both immutable source builds");
}
export async function verifyFixtureBundle(state: OtaRecord, version: string): Promise<void> {
  if (process.platform !== "darwin" || state.phase !== "prepared" || !state.nativeFixture) throw Error("Prepared native macOS fixture required");
  knownFixtureBytes(state, version);
  await run(state, ["/usr/bin/codesign", "--verify", "--deep", "--strict", state.currentApp]);
  for (const [role, binary] of [["cli", "Contents/Resources/pacer"], ["helper", "Contents/Resources/pacer-update-helper"], ["desktop", "Contents/MacOS/pacer"]] as const) validateFixtureIdentity(state, JSON.parse(await run(state, [join(state.currentApp, binary), "--pacer-identity"])), role, version);
}
export async function inspectFixtureJobs(state: OtaRecord, retire = false): Promise<FixtureJobs> {
  knownFixtureBytes(state);
  // Static verification precedes execution; the compiled helper separately proves
  // its role, live lease, both exact job definitions and loaded process identity.
  await run(state, ["/usr/bin/codesign", "--verify", "--deep", "--strict", state.currentApp]);
  const helper = join(state.currentApp, "Contents/Resources/pacer-update-helper");
  const identity = JSON.parse(await run(state, [helper, "--pacer-identity"]));
  if (![state.nativeFixture?.baselineVersion, state.nativeFixture?.candidateVersion].includes(identity.version)) throw Error("Unknown fixture helper version");
  validateFixtureIdentity(state, identity, "helper", identity.version);
  const report = jobsSchema.parse(JSON.parse(await run(state, [helper, retire ? "--ota-fixture-retire" : "--ota-fixture-inspect"])));
  if (report.jobs.length !== 2 || report.jobs[0].label !== state.serviceLabel || report.jobs[1].label !== state.recoveryLabel) throw Error("Fixture inspector returned foreign jobs");
  return report;
}

/** Install the lease's fixed external service registration through the compiled helper. */
export async function attachFixtureService(state: OtaRecord): Promise<FixtureJobs> {
  knownFixtureBytes(state);
  await run(state, ["/usr/bin/codesign", "--verify", "--deep", "--strict", state.currentApp]);
  await run(state, ["/usr/bin/codesign", "--verify", "--strict", fixtureExternalCli(state)]);
  const helper = join(state.currentApp, "Contents/Resources/pacer-update-helper");
  validateFixtureIdentity(state, JSON.parse(await run(state, [helper, "--pacer-identity"])), "helper", state.nativeFixture!.baselineVersion);
  const report = jobsSchema.parse(JSON.parse(await run(state, [helper, "--ota-fixture-attach"])));
  if (report.jobs.length !== 2 || report.jobs[0].label !== state.serviceLabel || report.jobs[1].label !== state.recoveryLabel) throw Error("Fixture attach returned foreign jobs");
  return report;
}

/** Only the separately recorded, same-policy diagnostic helper may retire a never-ready baseline. */
export async function retireFixtureStartupJobs(state: OtaRecord): Promise<FixtureJobs> {
  if (!state.diagnostics || !state.nativeFixture || state.exercise || state.runtime?.state !== "starting" || state.runtime.request !== null) throw Error("No fixed startup cleanup diagnostic is recorded");
  const { validateDiagnosticFiles } = await import("./ota-diagnostics");
  const directory = join(state.root, "diagnostics");
  validateDiagnosticFiles(directory, state.diagnostics, digest(JSON.stringify(otaFixturePolicy(state))));
  for (const name of ["pacer-startup-cleanup", "pacer-update-helper", ...(state.diagnostics.nativeShimSha256 ? ["libpacer-native.dylib"] : [])]) await run(state, ["/usr/bin/codesign", "--verify", "--strict", join(directory, name)]);
  const helper = join(directory, "pacer-update-helper");
  validateFixtureIdentity(state, JSON.parse(await run(state, [helper, "--pacer-identity"])), "helper", state.nativeFixture.baselineVersion);
  validateDiagnosticFiles(directory, state.diagnostics, digest(JSON.stringify(otaFixturePolicy(state))));
  return jobsSchema.parse(JSON.parse(await run(state, [helper, "--ota-fixture-retire"])));
}
