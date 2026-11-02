import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { artifactNames, environmentIdentity, makeCandidate, promote, readCandidate, seal, verifyHandoff, verifyPackagedPair, verifyPushEvent, verifyRunMetadata, verifyVersionFiles } from "../scripts/release/experiment";
import { benchmarkBranch, benchmarkRef, benchmarkRepository, benchmarkWorkflowPath, requiredJobs, variants } from "../scripts/release/experiment-benchmark";

const identity = { repository: "owner/repo", run: "123", attempt: "2", commit: "a".repeat(40), version: "1.2.3" };
const candidate = makeCandidate(identity, "2026-11-02T00:00:00Z");
const successNeeds = () => Object.fromEntries(requiredJobs.filter(name => name !== "promotion").map(name => [name, { result: "success" }]));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pacer-experiment-test-"));
  dirs.push(root);
  for (const v of variants) {
    const dir = join(root, v.id);
    mkdirSync(dir);
    for (const name of artifactNames(v.id, identity.version)) writeFileSync(join(dir, name), `fixture bytes: ${name}`);
    seal(candidate, identity, v.id, dir, v.id.startsWith("desktop-") ? join(root, v.id.replace("desktop-", "cli-")) : undefined);
  }
  return root;
}

describe("experiment handoffs and simulated promotion", () => {
  test("candidate refuses a request, desktop config or desktop Cargo version mismatch", () => {
    const root = fixture(), desktop = join(root, "desktop/src-tauri");
    mkdirSync(desktop, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(desktop, "tauri.conf.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(desktop, "Cargo.toml"), '[package]\nversion = "1.2.3"\n');
    expect(() => verifyVersionFiles(root, "1.2.3")).not.toThrow();
    expect(() => verifyVersionFiles(root, "1.2.4")).toThrow("version");
    writeFileSync(join(desktop, "tauri.conf.json"), JSON.stringify({ version: "1.2.4" }));
    expect(() => verifyVersionFiles(root, "1.2.3")).toThrow("version");
    writeFileSync(join(desktop, "tauri.conf.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(desktop, "Cargo.toml"), '[package]\nversion = "1.2.4"\n');
    expect(() => verifyVersionFiles(root, "1.2.3")).toThrow("version");
  });
  test("candidate digest is independently supplied and binds the exact bytes and identity", () => {
    const root = fixture(), path = join(root, "candidate.json"), bytes = JSON.stringify(candidate);
    writeFileSync(path, bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(readCandidate(path, hash, identity)).toEqual(candidate);
    for (const wrong of [undefined, "", "f".repeat(64)]) expect(() => readCandidate(path, wrong, identity)).toThrow("digest");
    expect(() => readCandidate(path, hash, { ...identity, run: "124" })).toThrow("identity");
    writeFileSync(path, bytes + "\n");
    expect(() => readCandidate(path, hash, identity)).toThrow("digest");
  });
  test("package smoke rejects changed packaged bytes before execution", () => {
    const root = fixture(), packed = join(root, "packed"), source = join(root, "cli-linux-x64");
    mkdirSync(packed);
    for (const name of ["pacer", "pacer-core"]) writeFileSync(join(packed, name), readFileSync(join(source, `${name}-linux-x64`)));
    expect(() => verifyPackagedPair(packed, source, "linux-x64")).not.toThrow();
    writeFileSync(join(packed, "pacer-core"), "corrupt");
    expect(() => verifyPackagedPair(packed, source, "linux-x64")).toThrow("digest");
  });
  test("validates every target and returns a no-write decision", () => {
    const root = fixture();
    const snapshot = () => readdirSync(root).sort().flatMap(dir => readdirSync(join(root, dir)).sort().map(file => [dir, file, readFileSync(join(root, dir, file), "utf8")]));
    const before = snapshot();
    const decision = promote(candidate, identity, root, successNeeds());
    expect(decision.mode).toBe("simulation-no-write");
    expect(decision.artifacts).toHaveLength(8);
    expect(snapshot()).toEqual(before);
    expect(decision.candidate).toEqual(candidate);
  });
  test("refuses foreign candidates, variants, bytes, config and missing handoffs", () => {
    const root = fixture(), dir = join(root, "cli-linux-x64");
    for (const changed of [{ run: "124" }, { attempt: "1" }, { commit: "b".repeat(40) }, { version: "1.2.4" }]) {
      expect(() => verifyHandoff(candidate, { ...identity, ...changed }, "cli-linux-x64", dir)).toThrow();
    }
    expect(() => verifyHandoff(candidate, identity, "cli-linux-arm64", dir)).toThrow();
    const config = join(dir, "configuration.json");
    writeFileSync(config, "{}");
    expect(() => verifyHandoff(candidate, identity, "cli-linux-x64", dir)).toThrow();
    expect(() => promote(candidate, identity, root, {})).toThrow();
    expect(() => promote(candidate, identity, root, { focused: { result: "failure" } })).toThrow();
    rmSync(join(root, "desktop-linux-arm64"), { recursive: true });
    expect(() => promote(candidate, identity, root, successNeeds())).toThrow();
  });
  test("rejects a validly resealed desktop handoff linked to the wrong CLI digest", () => {
    const root = fixture(), dir = join(root, "desktop-linux-x64");
    const source = JSON.parse(readFileSync(join(dir, "source.json"), "utf8"));
    expect(source.cliManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    // Change the CLI only after the desktop captured its producer's identity.
    const cli = join(root, "cli-linux-x64");
    writeFileSync(join(cli, "pacer-linux-x64"), "other candidate bytes");
    seal(candidate, identity, "cli-linux-x64", cli);
    expect(() => promote(candidate, identity, root, successNeeds())).toThrow("source");
  });
  test("rejects mismatched exact configuration in a candidate", () => {
    const root = fixture();
    const forged = structuredClone(candidate);
    forged.variants[0].profile = "debug";
    expect(() => promote(forged, identity, root, successNeeds())).toThrow();
  });
  test("promotion rejects each missing, skipped, cancelled or failed dependency even with valid artifacts", () => {
    const root = fixture();
    for (const name of Object.keys(successNeeds())) {
      const missing = successNeeds();
      delete missing[name];
      expect(() => promote(candidate, identity, root, missing)).toThrow();
      for (const result of ["skipped", "cancelled", "failure"]) {
        expect(() => promote(candidate, identity, root, { ...successNeeds(), [name]: { result } })).toThrow();
      }
    }
  });
  test("promotion rejects each missing handoff independently", () => {
    for (const variant of variants) {
      const root = fixture();
      rmSync(join(root, variant.id), { recursive: true });
      expect(() => promote(candidate, identity, root, successNeeds())).toThrow();
    }
  });
});

describe("benchmark event and run identity binding", () => {
  const sha = "c".repeat(40);
  const env = { GITHUB_REPOSITORY: benchmarkRepository, GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: sha,
    GITHUB_EVENT_NAME: "push", GITHUB_REF: benchmarkRef, GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: benchmarkBranch,
    GITHUB_WORKFLOW_REF: `${benchmarkRepository}/${benchmarkWorkflowPath}@${benchmarkRef}` };
  const bound = environmentIdentity(env, "1.2.3");
  const event = { ref: benchmarkRef, after: sha, deleted: false, head_commit: { id: sha },
    repository: { full_name: benchmarkRepository, pushed_at: 1793577600 } };
  const run = { id: 77, run_attempt: 1, head_sha: sha, event: "push", head_branch: benchmarkBranch,
    path: benchmarkWorkflowPath, repository: { full_name: benchmarkRepository }, created_at: "2026-11-02T00:00:05Z" };
  test("accepts only the exact push and returns the push receipt", () => {
    expect(bound).toEqual({ repository: benchmarkRepository, run: "77", attempt: "1", commit: sha, version: "1.2.3" });
    expect(verifyPushEvent(env, event, bound)).toBe("2026-11-02T00:00:00.000Z");
    expect(verifyPushEvent(env, { ...event, repository: { full_name: benchmarkRepository } }, bound)).toBeNull();
    expect(verifyRunMetadata(run, bound)).toBe(run);
  });
  test("refuses dispatch, schedule, PR, tag, other branch, fork and other workflow contexts", () => {
    for (const changed of [{ GITHUB_EVENT_NAME: "workflow_dispatch" }, { GITHUB_EVENT_NAME: "schedule" }, { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: `refs/tags/${benchmarkBranch}` }, { GITHUB_REF_TYPE: "tag" },
      { GITHUB_REF_NAME: "main" }, { GITHUB_REF: `${benchmarkRef}-2` }, { GITHUB_WORKFLOW_REF: `${benchmarkRepository}/.github/workflows/release.yml@${benchmarkRef}` },
      { GITHUB_WORKFLOW_REF: `${benchmarkRepository}/${benchmarkWorkflowPath}@refs/heads/main` }]) {
      expect(() => verifyPushEvent({ ...env, ...changed }, event, bound)).toThrow();
    }
    const fork = { ...env, GITHUB_REPOSITORY: "someone/pacer", GITHUB_WORKFLOW_REF: `someone/pacer/${benchmarkWorkflowPath}@${benchmarkRef}` };
    expect(() => verifyPushEvent(fork, { ...event, repository: { full_name: "someone/pacer" } }, environmentIdentity(fork, "1.2.3"))).toThrow();
  });
  test("binds the event payload to the run SHA and branch", () => {
    for (const changed of [{ after: "d".repeat(40) }, { ref: "refs/heads/main" }, { deleted: true }, { head_commit: { id: "d".repeat(40) } },
      { repository: { full_name: "other/repo", pushed_at: 1 } }]) {
      expect(() => verifyPushEvent(env, { ...event, ...changed }, bound)).toThrow();
    }
    for (const bad of [null, undefined, {}]) expect(() => verifyPushEvent(env, bad, bound)).toThrow();
  });
  test("binds run metadata to the exact run, attempt, SHA, push event, branch and workflow file", () => {
    for (const changed of [{ id: 78 }, { run_attempt: 2 }, { head_sha: "d".repeat(40) }, { event: "workflow_dispatch" },
      { head_branch: "main" }, { path: ".github/workflows/release.yml" }, { repository: { full_name: "other/repo" } }, { created_at: "invalid" }]) {
      expect(() => verifyRunMetadata({ ...run, ...changed }, bound)).toThrow();
    }
    expect(() => verifyRunMetadata(null, bound)).toThrow();
  });
});
