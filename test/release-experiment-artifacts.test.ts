import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { artifactNames } from "../scripts/release/experiment";
import { benchmarkWorkflowPath, variants } from "../scripts/release/experiment-benchmark";

// Models of the pinned actions' file placement, not of their transport. The download model
// mirrors src/download-artifact.ts at actions/download-artifact@d3f86a10 (v4.3.0); the upload
// model mirrors the artifact root rule of @actions/artifact used by actions/upload-artifact@ea165f8d.
type Artifact = { id: number; name: string; files: Map<string, Buffer> };
type Inputs = Record<string, unknown>;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "pacer-artifact-model-")); dirs.push(dir); return dir; }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]);
}
function input(inputs: Inputs, key: string, fallback = "") { return inputs[key] === undefined ? fallback : String(inputs[key]).trim(); }
function booleanInput(value: string) {
  // core.getBooleanInput accepts only the YAML 1.2 core schema spellings.
  if (["true", "True", "TRUE"].includes(value)) return true;
  if (["false", "False", "FALSE"].includes(value)) return false;
  throw TypeError(`Input does not meet YAML 1.2 "Core Schema" specification: ${value}`);
}

function uploadArtifact(workspace: string, inputs: Inputs, store: Artifact[]): Artifact {
  const searchPath = resolve(workspace, input(inputs, "path"));
  if (input(inputs, "path").includes("\n") || /[*?[]/.test(input(inputs, "path"))) throw Error("model supports one literal path");
  const results = !existsSync(searchPath) ? [] : statSync(searchPath).isDirectory() ? walk(searchPath) : [searchPath];
  const files = results.filter(file => !relative(searchPath, file).split("/").some(part => part.startsWith(".")));
  if (!files.length) throw Error(`No files were found with the provided path: ${input(inputs, "path")}`);
  // A single literal file is rooted at its parent; a directory is rooted at itself.
  const root = files.length === 1 && files[0] === searchPath ? dirname(searchPath) : searchPath;
  if (store.some(a => a.name === input(inputs, "name"))) throw Error("artifact name conflict");
  const artifact = { id: 9000 + store.length, name: input(inputs, "name"), files: new Map(files.map(f => [relative(root, f), readFileSync(f)])) };
  store.push(artifact);
  return artifact;
}

function downloadArtifact(workspace: string, inputs: Inputs, store: Artifact[]): string[] {
  if (input(inputs, "run-id") || input(inputs, "github-token") || input(inputs, "repository")) throw Error("model is current-run only");
  const name = input(inputs, "name"), ids = input(inputs, "artifact-ids"), pattern = input(inputs, "pattern");
  const mergeMultiple = booleanInput(input(inputs, "merge-multiple", "false"));
  const path = resolve(workspace, input(inputs, "path") || ".");
  if (name && ids) throw Error("Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one.");
  let artifacts: Artifact[];
  if (name) {
    const found = store.find(a => a.name === name);
    if (!found) throw Error(`Artifact '${name}' not found`);
    artifacts = [found];
  } else if (ids) {
    const list = ids.split(",").map(id => id.trim()).filter(Boolean);
    if (!list.length) throw Error("No valid artifact IDs provided in 'artifact-ids' input");
    const numeric = list.map(id => { const n = parseInt(id, 10); if (Number.isNaN(n)) throw Error(`Invalid artifact ID: '${id}'. Must be a number.`); return n; });
    artifacts = store.filter(a => numeric.includes(a.id));
    if (!artifacts.length) throw Error("None of the provided artifact IDs were found");
  } else {
    if (pattern) throw Error("model does not implement pattern");
    artifacts = [...store]; // an empty artifact-ids input falls through to downloading every artifact
  }
  const written: string[] = [];
  for (const artifact of artifacts) {
    const target = name || mergeMultiple ? path : join(path, artifact.name);
    for (const [file, bytes] of artifact.files) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      writeFileSync(join(target, file), bytes);
      written.push(relative(workspace, join(target, file)));
    }
  }
  return written.sort();
}

// ---------------------------------------------------------------------------------------------
// Whole-workflow simulation: each job gets a fresh workspace, producers write stub files with the
// exact names the real scripts write, and every consumer path is resolved from the workflow.
const run = { id: "41437535098", attempt: "1", version: "1.2.3" };
const sealed = (variant: string) =>
  [...artifactNames(variant, run.version), "configuration.json", ...(variant.startsWith("desktop-") ? ["source.json"] : []), "handoff.json"].sort();

function topological(jobs: Record<string, any>): string[] {
  const order: string[] = [], seen = new Set<string>();
  const visit = (id: string) => { if (seen.has(id)) return; seen.add(id); for (const p of jobs[id].needs ?? []) visit(p); order.push(id); };
  Object.keys(jobs).forEach(visit);
  return order;
}
function expression(value: string, ctx: { env: Record<string, string>; needs: Record<string, Record<string, string>>; steps: Record<string, Record<string, string>> }) {
  return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    if (expr === "github.run_id") return run.id;
    if (expr === "github.run_attempt") return run.attempt;
    if (expr === "github.sha") return "a".repeat(40);
    if (expr === "github.token") return "<token>";
    if (expr === "toJSON(needs)") return JSON.stringify(ctx.needs);
    let m = expr.match(/^env\.([A-Z_]+)$/);
    if (m) return ctx.env[m[1]] ?? "";
    m = expr.match(/^needs\.([\w-]+)\.outputs\.([\w-]+)$/);
    if (m) return ctx.needs[m[1]]?.[m[2]] ?? "";
    m = expr.match(/^steps\.([\w-]+)\.outputs\.([\w-]+)$/);
    if (m) return ctx.steps[m[1]]?.[m[2]] ?? "";
    throw Error(`unmodelled expression: ${expr}`);
  });
}
function words(script: string, env: Record<string, string>): string[][] {
  // Enough shell for these scripts: one command per line, quoted words and $VAR expansion of job/step env.
  return script.split("\n").map(line => [...line.matchAll(/"([^"]*)"|(\S+)/g)]
    .map(m => (m[1] ?? m[2]).replace(/\$([A-Z_]+)/g, (all, k) => env[k] ?? all)));
}
function files(dir: string) { return existsSync(dir) ? readdirSync(dir).sort() : []; }

function simulate(workflow: any) {
  const jobs = workflow.jobs, store: Artifact[] = [], outputs: Record<string, Record<string, string>> = {};
  const consumed: string[] = [];
  let candidateBytes = "";
  for (const id of topological(jobs)) {
    const job = jobs[id], workspace = temp(), steps: Record<string, Record<string, string>> = {};
    const needs = Object.fromEntries((job.needs ?? []).map((n: string) => [n, { ...outputs[n], result: "success" }]));
    const ctx = { env: {} as Record<string, string>, needs, steps };
    for (const [k, v] of Object.entries(job.env ?? {})) ctx.env[k] = expression(String(v), ctx);
    for (const step of job.steps) {
      const env = { ...ctx.env, ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, expression(String(v), ctx)])) };
      const inputs = Object.fromEntries(Object.entries(step.with ?? {}).map(([k, v]) => [k, typeof v === "string" ? expression(v, { ...ctx, env }) : v]));
      if (step.uses?.startsWith("actions/upload-artifact@")) {
        const artifact = uploadArtifact(workspace, inputs, store);
        if (step.id) steps[step.id] = { "artifact-id": String(artifact.id) };
      } else if (step.uses?.startsWith("actions/download-artifact@")) downloadArtifact(workspace, inputs, store);
      else if (step.run) for (const argv of words(step.run, env)) {
        const at = (p: string) => join(workspace, p);
        if (argv[0] === "bun" && argv[1] === "scripts/release/experiment.ts") {
          const [action, variant, dir, source] = argv.slice(2);
          if (action === "candidate") {
            mkdirSync(at("candidate"), { recursive: true });
            candidateBytes = `candidate ${run.id}`;
            writeFileSync(at("candidate/candidate.json"), candidateBytes);
            continue;
          }
          if (action === "report") { mkdirSync(at("benchmark"), { recursive: true }); writeFileSync(at("benchmark/report.json"), "{}"); continue; }
          // Every other action reads the immutable candidate from CANDIDATE_PATH, with no default.
          if (!env.CANDIDATE_PATH) throw Error(`${id}: Missing CANDIDATE_PATH`);
          if (!existsSync(at(env.CANDIDATE_PATH)) || readFileSync(at(env.CANDIDATE_PATH), "utf8") !== candidateBytes) throw Error(`${id}: candidate not at ${env.CANDIDATE_PATH}`);
          consumed.push(`${id}:candidate`);
          if (action === "prepare-cli" || action === "seal") {
            if (source) { expect(files(at(source))).toEqual(sealed(variant.replace("desktop-", "cli-"))); consumed.push(`${id}:${source}`); }
            mkdirSync(at(dir), { recursive: true });
            for (const name of sealed(variant)) writeFileSync(at(join(dir, name)), `${variant}/${name}`);
          } else if (action === "verify") {
            if (files(at(dir)).join() !== sealed(variant).join()) throw Error(`${id}: ${variant} handoff not at ${dir}: ${files(at(dir))}`);
            consumed.push(`${id}:${dir}`);
          } else if (action === "smoke-desktop") {
            expect(files(at(dir))).toEqual(sealed(variant));
            if (files(at(source)).join() !== sealed(variant.replace("desktop-", "cli-")).join()) throw Error(`${id}: CLI source not at ${source}`);
          } else if (action === "promote") {
            for (const v of variants) {
              if (files(at(join("handoffs", v.id))).join() !== sealed(v.id).join()) throw Error(`${id}: ${v.id} handoff missing`);
              consumed.push(`${id}:handoffs/${v.id}`);
            }
            mkdirSync(at("simulation"), { recursive: true });
            writeFileSync(at("simulation/promotion.json"), "{}");
          } else throw Error(`unmodelled action ${action}`);
        } else if (argv[0] === "desktop/scripts/stage-cli.sh" || argv[0] === "desktop/scripts/build-linux-bundles.sh") {
          if (!existsSync(at(argv[1]))) throw Error(`${id}: ${argv[0]} input missing: ${argv[1]}`);
          if (argv[0].endsWith("build-linux-bundles.sh")) {
            mkdirSync(at(`out/${id}`), { recursive: true });
            for (const name of artifactNames(id, run.version)) writeFileSync(at(`out/${id}/${name}`), name);
          }
        } else if (argv[0] === "cp" && argv.some(a => a.includes("/manifest.json"))) {
          for (const src of argv.slice(1, -1).filter(a => !a.includes("*"))) if (!existsSync(at(src))) throw Error(`${id}: cp source missing: ${src}`);
        }
      }
    }
    outputs[id] = Object.fromEntries(Object.entries(job.outputs ?? {}).map(([k, v]) => [k, expression(String(v), ctx)]));
  }
  return { store, consumed };
}
const workflow = () => parse(readFileSync(benchmarkWorkflowPath, "utf8"));

test("download-artifact places artifact-ids downloads under the artifact name unless merged", () => {
  const store: Artifact[] = [], producer = temp();
  mkdirSync(join(producer, "candidate"));
  writeFileSync(join(producer, "candidate/candidate.json"), "{}");
  const { id } = uploadArtifact(producer, { name: `candidate-${run.id}-1`, path: "candidate/candidate.json" }, store);
  const ids = String(id);
  // Run 41437535098 (cli-linux-arm64): the default merge-multiple false nests by artifact name.
  expect(downloadArtifact(temp(), { "artifact-ids": ids, path: "candidate" }, store)).toEqual([`candidate/candidate-${run.id}-1/candidate.json`]);
  expect(downloadArtifact(temp(), { "artifact-ids": ids, "merge-multiple": false, path: "candidate" }, store)).toEqual([`candidate/candidate-${run.id}-1/candidate.json`]);
  expect(downloadArtifact(temp(), { "artifact-ids": ids, "merge-multiple": true, path: "candidate" }, store)).toEqual(["candidate/candidate.json"]);
  // A name download is single-artifact and always flat; merge-multiple is ignored.
  expect(downloadArtifact(temp(), { name: `candidate-${run.id}-1`, path: "candidate" }, store)).toEqual(["candidate/candidate.json"]);
  expect(() => downloadArtifact(temp(), { name: "x", "artifact-ids": ids }, store)).toThrow("cannot be used together");
  expect(() => downloadArtifact(temp(), { "artifact-ids": "1" }, store)).toThrow("None of the provided artifact IDs");
  expect(() => downloadArtifact(temp(), { "artifact-ids": ids, "merge-multiple": "yes" }, store)).toThrow("Core Schema");
  // An empty ID input is not a filter: it downloads every artifact in the run.
  writeFileSync(join(producer, "other.json"), "{}");
  uploadArtifact(producer, { name: "other", path: "other.json" }, store);
  expect(downloadArtifact(temp(), { "artifact-ids": "", path: "c" }, store)).toEqual([`c/candidate-${run.id}-1/candidate.json`, "c/other/other.json"]);
});

test("upload-artifact roots a single file at its parent and a directory at itself", () => {
  const store: Artifact[] = [], producer = temp();
  mkdirSync(join(producer, "out/cli-linux-arm64/sub"), { recursive: true });
  writeFileSync(join(producer, "out/cli-linux-arm64/a"), "a");
  writeFileSync(join(producer, "out/cli-linux-arm64/sub/b"), "b");
  writeFileSync(join(producer, "out/cli-linux-arm64/.hidden"), "h");
  expect([...uploadArtifact(producer, { name: "dir", path: "out/cli-linux-arm64/" }, store).files.keys()].sort()).toEqual(["a", "sub/b"]);
  expect([...uploadArtifact(producer, { name: "file", path: "out/cli-linux-arm64/a" }, store).files.keys()]).toEqual(["a"]);
  expect(() => uploadArtifact(producer, { name: "none", path: "missing" }, store)).toThrow("No files were found");
});

test("every artifact-ids download sets merge-multiple explicitly and uses a trusted upload ID", () => {
  const jobs = workflow().jobs;
  let count = 0;
  for (const [id, job] of Object.entries(jobs) as [string, any][]) for (const step of job.steps) {
    if (!step.uses?.startsWith("actions/download-artifact@")) continue;
    expect(step.with.pattern).toBeUndefined();
    if (step.with.name !== undefined) { expect(step.with["artifact-ids"]).toBeUndefined(); continue; }
    count++;
    expect(step.with["merge-multiple"]).toBe(false);
    const m = String(step.with["artifact-ids"]).match(/^\$\{\{ needs\.([\w-]+)\.outputs\.artifact \}\}$/);
    expect(m).not.toBeNull();
    expect(job.needs).toContain(m![1]);
    // The ID comes only from the producer's own upload step output, never from a name lookup.
    expect(jobs[m![1]].outputs.artifact).toBe("${{ steps.upload.outputs.artifact-id }}");
    expect(jobs[m![1]].steps.filter((s: any) => s.id === "upload" && s.uses?.startsWith("actions/upload-artifact@"))).toHaveLength(1);
    expect(id).not.toBe(m![1]);
  }
  expect(count).toBe(13); // 4 CLI + 4 desktop + promotion candidate downloads, + 4 desktop CLI handoffs
});

test("simulated run delivers every handoff to the exact path its consumer reads", () => {
  const { store, consumed } = simulate(workflow());
  expect(store.map(a => a.name).sort()).toEqual([
    `benchmark-${run.id}-1`, `candidate-${run.id}-1`, `promotion-simulation-${run.id}-1`,
    ...variants.map(v => `${v.id}-${run.id}-1`),
  ].sort());
  for (const v of variants) expect(consumed).toContain(`${v.id}:candidate`);
  expect(consumed).toContain("promotion:candidate");
  for (const v of variants.filter(v => v.id.startsWith("cli-"))) {
    expect(consumed).toContain(`desktop-${v.platform}:source/${v.id}-${run.id}-1`);
    expect(consumed).toContain(`promotion:handoffs/${v.id}`);
  }
});

test("simulation reproduces the hosted failure with the previous flat candidate path", () => {
  const broken = workflow();
  // Before the fix every consumer read candidate/candidate.json from an artifact-ids download.
  for (const job of Object.values(broken.jobs) as any[]) if (job.env?.CANDIDATE_PATH) job.env.CANDIDATE_PATH = "candidate/candidate.json";
  expect(() => simulate(broken)).toThrow("cli-darwin-arm64: candidate not at candidate/candidate.json");
  const flatSource = workflow();
  for (const job of Object.values(flatSource.jobs) as any[]) if (job.env?.SOURCE) job.env.SOURCE = "source";
  expect(() => simulate(flatSource)).toThrow("handoff not at source");
});
