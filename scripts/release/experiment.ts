#!/usr/bin/env bun
// This entry point has no publishing adapter. All outputs are local experiment evidence.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createExperimentManifest, inspectExperimentFile, validateIdentity, verifyExperimentManifest, type ExperimentManifest } from "./experiment-identity";
import { benchmarkBranch, benchmarkMarkdown, benchmarkRef, benchmarkReport, benchmarkRepository, benchmarkWorkflowPath, requiredJobs, variants, type BenchmarkJob, type CandidateIdentity } from "./experiment-benchmark";

export function makeCandidate(identity: CandidateIdentity, t0: string) {
  // Reuse the identity validator before accepting environment or API data.
  validateIdentity({ ...identity, variant: "candidate" });
  if (!Number.isFinite(Date.parse(t0))) throw Error("Invalid dispatch receipt");
  return { schema: 1, ...identity, t0, variants: structuredClone(variants) };
}
export type Candidate = ReturnType<typeof makeCandidate>;
function validateCandidate(candidate: Candidate, expected: CandidateIdentity): void {
  if (!candidate || JSON.stringify(candidate) !== JSON.stringify(makeCandidate(expected, candidate.t0))) throw Error("candidate identity/configuration mismatch");
}
function configuration(variant: string) {
  const config = variants.find(v => v.id === variant);
  if (!config) throw Error("Unknown experiment variant");
  return config;
}
export function artifactNames(variant: string, version: string): string[] {
  const config = configuration(variant), platform = config.platform;
  if (variant.startsWith("cli-")) return [`pacer-${platform}`, `pacer-core-${platform}`, "manifest.json", "SHA256SUMS"];
  const prefix = `pacer-${version}-${platform}-unsigned`;
  return platform.startsWith("darwin-") ? [`${prefix}.zip`] : [`${prefix}.AppImage`, `${prefix}.deb`];
}
function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }
function writeJson(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); }
export function verifyVersionFiles(root: string, requested: string | undefined): void {
  const version = json(join(root, "package.json")).version;
  const desktop = join(root, "desktop/src-tauri");
  const cargo = Bun.TOML.parse(readFileSync(join(desktop, "Cargo.toml"), "utf8")) as { package?: { version?: unknown } };
  if (requested !== version || json(join(desktop, "tauri.conf.json")).version !== version || cargo.package?.version !== version) throw Error("Candidate version mismatch");
}
function sealedNames(variant: string, version: string): string[] {
  return [...artifactNames(variant, version), "configuration.json", ...(variant.startsWith("desktop-") ? ["source.json"] : [])];
}

export function seal(candidate: Candidate, expected: CandidateIdentity, variant: string, dir: string, sourceDir?: string): ExperimentManifest {
  validateCandidate(candidate, expected);
  const config = configuration(variant);
  writeJson(join(dir, "configuration.json"), config);
  if (variant.startsWith("desktop-")) {
    if (!sourceDir) throw Error("Missing CLI source handoff");
    const cli = variant.replace("desktop-", "cli-");
    verifyHandoff(candidate, expected, cli, sourceDir);
    writeJson(join(dir, "source.json"), { variant: cli, cliManifestSha256: digest(join(sourceDir, "handoff.json")) });
  }
  const manifest = createExperimentManifest({ ...expected, variant }, dir, sealedNames(variant, expected.version));
  writeJson(join(dir, "handoff.json"), manifest);
  return manifest;
}

export function verifyHandoff(candidate: Candidate, expected: CandidateIdentity, variant: string, dir: string): ExperimentManifest {
  validateCandidate(candidate, expected);
  const names = sealedNames(variant, expected.version);
  if (JSON.stringify(readdirSync(dir).sort()) !== JSON.stringify([...names, "handoff.json"].sort())) throw Error("unexpected artifact set");
  const manifest = json(join(dir, "handoff.json")) as ExperimentManifest;
  verifyExperimentManifest(manifest, { ...expected, variant }, dir, names);
  if (JSON.stringify(json(join(dir, "configuration.json"))) !== JSON.stringify(configuration(variant))) throw Error("configuration mismatch");
  return manifest;
}

export function promote(candidate: Candidate, expected: CandidateIdentity, root: string, needs: Record<string, { result: string }>) {
  validateCandidate(candidate, expected);
  for (const name of requiredJobs.filter(name => name !== "promotion")) {
    if (needs[name]?.result !== "success") throw Error(`Missing or unsuccessful dependency job: ${name}`);
  }
  const artifacts = variants.map(v => {
    const dir = join(root, v.id);
    const manifest = verifyHandoff(candidate, expected, v.id, dir);
    if (v.id.startsWith("desktop-")) {
      const source = json(join(dir, "source.json")), cli = v.id.replace("desktop-", "cli-");
      if (source.variant !== cli || source.cliManifestSha256 !== digest(join(root, cli, "handoff.json"))) throw Error("desktop source digest mismatch");
    }
    return { variant: v.id, manifestSha256: digest(join(dir, "handoff.json")), files: manifest.files };
  });
  return { mode: "simulation-no-write", candidate, artifacts };
}

async function run(argv: string[], env = process.env): Promise<string> {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(`${argv[0]} failed (${code}): ${stderr.slice(0, 1000)}`);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}

/** Execute only the just-verified native pair in a disposable home, never service/install operations. */
async function smokePair(dir: string, platform: string, version: string, suffixed = true) {
  if (`${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}` !== platform) throw Error("Smoke requires the exact native platform");
  const home = mkdtempSync(join(tmpdir(), "pacer-experiment-smoke-"));
  const env = { ...process.env, HOME: home, PACER_HOME: join(home, ".pacer"), PACER_BIN: undefined };
  try {
    for (const name of suffixed ? [`pacer-${platform}`, `pacer-core-${platform}`] : ["pacer", "pacer-core"]) {
      const file = resolve(dir, name);
      chmodSync(file, 0o755);
      if (await run([file, "--version"], env) !== `pacer ${version}`) throw Error("native version smoke mismatch");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Byte comparison precedes any execution of the extracted payload. */
export function verifyPackagedPair(dir: string, source: string, platform: string): void {
  for (const name of ["pacer", "pacer-core"]) {
    const expected = inspectExperimentFile(dir, name);
    if (expected.sha256 !== digest(join(source, `${name}-${platform}`))) throw Error("Packaged CLI digest mismatch");
  }
}

async function smokeDesktop(candidate: Candidate, identity: CandidateIdentity, variant: string, directory: string, sourceDir: string) {
  const config = configuration(variant);
  verifyHandoff(candidate, identity, variant, directory);
  verifyHandoff(candidate, identity, variant.replace("desktop-", "cli-"), sourceDir);
  const temp = mkdtempSync(join(tmpdir(), "pacer-experiment-package-"));
  try {
    for (const name of artifactNames(variant, identity.version)) {
      const extracted = join(temp, name);
      mkdirSync(extracted);
      const archive = resolve(directory, name);
      let pair: string;
      if (name.endsWith(".zip")) {
        await run(["ditto", "-x", "-k", archive, extracted]);
        pair = join(extracted, "pacer.app/Contents/Resources");
      } else if (name.endsWith(".deb")) {
        await run(["dpkg-deb", "-x", archive, extracted]);
        pair = join(extracted, "usr/bin");
      } else {
        chmodSync(archive, 0o755);
        const offset = await run([archive, "--appimage-offset"]);
        if (!/^\d+$/.test(offset)) throw Error("Invalid AppImage offset");
        await run(["unsquashfs", "-q", "-no-progress", "-d", join(extracted, "root"), "-o", offset, archive]);
        pair = join(extracted, "root/usr/bin");
      }
      verifyPackagedPair(pair, sourceDir, config.platform);
      await smokePair(pair, config.platform, identity.version, false);
      if (name.endsWith(".zip")) {
        const env = { ...process.env, HOME: temp, PACER_HOME: join(temp, ".pacer"), PACER_BIN: undefined };
        for (const file of [join(extracted, "pacer.app/Contents/MacOS/pacer"), join(pair, "pacer-update-helper")]) {
          if (await run([file, "--version"], env) !== identity.version) throw Error("Packaged desktop version mismatch");
        }
      }
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

async function github(path: string) {
  // Only fixed read-only Actions endpoints are passed by the callers below.
  const response = await fetch(`https://api.github.com${path}`, { headers: {
    Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
  }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error(`Actions API read failed: ${response.status}`);
  return response.json() as Promise<any>;
}
export function environmentIdentity(env: Record<string, string | undefined>, version: string): CandidateIdentity {
  const identity = { repository: env.GITHUB_REPOSITORY ?? "", run: env.GITHUB_RUN_ID ?? "",
    attempt: env.GITHUB_RUN_ATTEMPT ?? "", commit: env.GITHUB_SHA ?? "", version };
  if (!/^[\w.-]+\/[\w.-]+$/.test(identity.repository) || !/^[1-9]\d*$/.test(identity.run) || !/^[1-9]\d*$/.test(identity.attempt) ||
      !/^[0-9a-f]{40}$/.test(identity.commit) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(identity.version)) throw Error("Invalid Actions identity");
  return identity;
}
/** Binds every job to the exact push event on the benchmark branch; returns GitHub's push receipt time. */
export function verifyPushEvent(env: Record<string, string | undefined>, event: any, identity: CandidateIdentity): string | null {
  if (identity.repository !== benchmarkRepository || env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== benchmarkRef ||
      env.GITHUB_REF_TYPE !== "branch" || env.GITHUB_REF_NAME !== benchmarkBranch ||
      env.GITHUB_WORKFLOW_REF !== `${benchmarkRepository}/${benchmarkWorkflowPath}@${benchmarkRef}`) throw Error("Benchmark runs only on a push to its exact branch");
  if (!event || event.ref !== benchmarkRef || event.after !== identity.commit || event.deleted === true ||
      event.repository?.full_name !== benchmarkRepository || (event.head_commit && event.head_commit.id !== identity.commit)) throw Error("Push event identity mismatch");
  const pushed = event.repository?.pushed_at;
  return typeof pushed === "number" && Number.isFinite(pushed) ? new Date(pushed * 1000).toISOString() : null;
}
export function verifyRunMetadata(data: any, identity: CandidateIdentity) {
  if (!data || String(data.id) !== identity.run || String(data.run_attempt) !== identity.attempt || data.head_sha !== identity.commit ||
      data.event !== "push" || data.head_branch !== benchmarkBranch || data.repository?.full_name !== identity.repository ||
      data.path !== benchmarkWorkflowPath || !Number.isFinite(Date.parse(data.created_at))) throw Error("Actions run identity mismatch");
  return data;
}
async function runMetadata(identity: CandidateIdentity) {
  return verifyRunMetadata(await github(`/repos/${identity.repository}/actions/runs/${identity.run}/attempts/${identity.attempt}`), identity);
}
export function readCandidate(path: string, hash: string | undefined, expected: CandidateIdentity): Candidate {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || digest(path) !== hash) throw Error("candidate digest mismatch");
  const candidate = json(path);
  validateCandidate(candidate, expected);
  return candidate;
}

if (import.meta.main) {
  try {
    const [action, variant, directory, sourceDir] = process.argv.slice(2);
    const identity = environmentIdentity(process.env, json("package.json").version);
    const pushedAt = verifyPushEvent(process.env, json(process.env.GITHUB_EVENT_PATH ?? ""), identity);
    if (await run(["git", "rev-parse", "HEAD"]) !== identity.commit) throw Error("Checkout SHA mismatch");
    if (action === "candidate") {
      // Push events carry no inputs: the package version must match the desktop versions at this SHA.
      verifyVersionFiles(process.cwd(), identity.version);
      const metadata = await runMetadata(identity);
      mkdirSync("candidate", { recursive: true });
      writeJson("candidate/candidate.json", makeCandidate(identity, metadata.created_at));
      if (!process.env.GITHUB_OUTPUT) throw Error("Missing Actions output file");
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${identity.version}\nsha=${identity.commit}\ndigest=${digest("candidate/candidate.json")}\n`);
    } else if (action === "report") {
      mkdirSync("benchmark", { recursive: true });
      // Write a failure artifact even if the API is unavailable; no success fallback.
      try {
        const metadata = await runMetadata(identity), jobs: BenchmarkJob[] = [];
        for (let page = 1; ; page++) {
          const result = await github(`/repos/${identity.repository}/actions/runs/${identity.run}/attempts/${identity.attempt}/jobs?per_page=100&page=${page}`);
          if (!Array.isArray(result.jobs)) throw Error("Missing Actions job list");
          jobs.push(...result.jobs);
          if (jobs.length >= result.total_count) break;
          if (!result.jobs.length || page >= 100) throw Error("Incomplete job pagination");
        }
        const report = benchmarkReport(identity, metadata.created_at, jobs, new Date().toISOString(), pushedAt);
        writeJson("benchmark/report.json", report);
        const markdown = benchmarkMarkdown(report);
        writeFileSync("benchmark/report.md", markdown);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
        if (report.verdict !== "PASS") throw Error(`Lower-bound benchmark ${report.lowerBound}: ${report.problems.join("; ")}`);
      } catch (error) {
        // Preserve a full measured report when available.
        if (!readdirSync("benchmark").includes("report.md")) {
          writeJson("benchmark/report.json", { kind: "hosted-lower-bound-build-benchmark", verdict: "FAIL", lowerBound: "UNVERIFIED", fullReleaseDeadline: "UNVERIFIED", error: (error as Error).message });
          writeFileSync("benchmark/report.md", `# Lower-bound benchmark FAIL / UNVERIFIED (not a release)\n\n${(error as Error).message}\n`);
        }
        throw error;
      }
    } else {
      // Required: artifact-ids downloads nest under the artifact name, so no flat default is assumed.
      if (!process.env.CANDIDATE_PATH) throw Error("Missing CANDIDATE_PATH");
      const candidate = readCandidate(process.env.CANDIDATE_PATH, process.env.CANDIDATE_DIGEST, identity);
      if (action === "promote") {
        const decision = promote(candidate, identity, "handoffs", JSON.parse(process.env.NEEDS_JSON ?? "{}"));
        mkdirSync("simulation", { recursive: true });
        writeJson("simulation/promotion.json", decision);
      } else if (action === "prepare-cli") {
        configuration(variant);
        if (!variant.startsWith("cli-")) throw Error("Expected CLI variant");
        mkdirSync(directory, { recursive: true });
        for (const file of artifactNames(variant, identity.version)) copyFileSync(join("dist/release", identity.version, file), join(directory, file));
        seal(candidate, identity, variant, directory);
        await smokePair(directory, configuration(variant).platform, identity.version);
      } else if (action === "verify") {
        verifyHandoff(candidate, identity, variant, directory);
        if (variant.startsWith("cli-")) await smokePair(directory, configuration(variant).platform, identity.version);
      } else if (action === "seal") seal(candidate, identity, variant, directory, sourceDir);
      else if (action === "smoke-desktop") await smokeDesktop(candidate, identity, variant, directory, sourceDir);
      else throw Error("Unknown experiment action");
    }
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
