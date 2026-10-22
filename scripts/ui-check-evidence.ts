import { readFileSync } from "node:fs";

export interface UiEvidenceViolation { rule: string; message: string }

const uiPath = /^(?:app\/(?:src\/.*\.(?:[jt]sx?|css|json|html|svg|png)|tokens-gen\.ts|build\.ts)|src\/app\/assets\.generated\.ts|src\/(?:dashboard|render|view-model)\/.*\.(?:ts|tsx)|desktop\/(?:ui\/.*\.(?:html|css|[jt]sx?|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)|src-tauri\/(?:src\/.*\.rs|icons\/.*\.(?:svg|png|jpe?g|gif|webp|ico|icns)|tauri(?:\.[a-z-]+)?\.conf\.json)))$/s;
const sha = /^[a-f0-9]{40}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function concreteReference(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^artifact:\/\/[a-zA-Z0-9_-]+\/[^\s]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname !== "/";
  } catch { return false; }
}

/** Validate a report manifest, not the truth of review or visual evidence. */
export function checkUiEvidence(files: string[], body: string, base?: string, head?: string, draft = false): UiEvidenceViolation[] {
  if (!files.some(path => uiPath.test(path))) return [];
  const fail = (message: string): UiEvidenceViolation => ({ rule: "UI-24", message });
  const manifests = [...body.matchAll(/<!--\s*pacer-ui-evidence\s*\n([\s\S]*?)-->/g)];
  if (manifests.length !== 1) return [fail("UI changes require exactly one pacer-ui-evidence JSON manifest with compliance, UI and QA report links; a checkbox is not evidence.")];
  let value: unknown;
  try { value = JSON.parse(manifests[0]![1]!); }
  catch { return [fail("pacer-ui-evidence must contain valid JSON.")]; }
  if (!record(value) || value.version !== 1) return [fail("pacer-ui-evidence must be a version: 1 object.")];
  const violations: UiEvidenceViolation[] = [];
  for (const [key, expected] of [["base", base], ["head", head]] as const) {
    if (typeof value[key] !== "string" || !sha.test(value[key]) || (expected && value[key] !== expected)) violations.push(fail(`Evidence ${key} must identify the PR's current reviewed ${key} SHA.`));
  }
  for (const key of ["compliance", "ui", "qa"]) {
    const report = value[key];
    if (!record(report)) { violations.push(fail(`Missing ${key} report with verdict, report reference and summary.`)); continue; }
    if (draft ? !["PASS", "FAIL", "UNVERIFIED"].some(verdict => verdict === report.verdict) : report.verdict !== "PASS") {
      violations.push(fail(draft
        ? `${key} draft report must state PASS, FAIL or UNVERIFIED honestly.`
        : `${key} verdict must be PASS before merge; FAIL/UNVERIFIED work remains outstanding.`));
    }
    if (!concreteReference(report.report)) violations.push(fail(`${key} report needs an accessible HTTPS report/comment URL or artifact://artifact-name/report-path reference; local paths and checkboxes do not qualify.`));
    if (typeof report.summary !== "string" || report.summary.trim().length < 12) {
      violations.push(fail(`${key} summary must describe the actual checks and their results.`));
    } else if ((!draft || report.verdict === "PASS") && /\b(?:FAIL|UNVERIFIED|UNKNOWN)\b/i.test(report.summary)) {
      violations.push(fail(`${key} summary must describe actual passing checks without outstanding FAIL/UNVERIFIED behavior.`));
    }
  }
  return violations;
}

/** A version bump rewrites these lines and nothing else; it changes nothing a reviewer could see. */
const versionLine = /^[+-][ \t]*(?:"version": "[0-9A-Za-z.+-]+",?|export const APP_VERSION = "[0-9A-Za-z.+-]+";)[ \t]*$/;

/** True only when every changed line of every UI-scoped file is a version string (release PRs). */
export function versionOnlyUiChange(files: string[], base: string, head: string, root = process.cwd()): boolean {
  const ui = files.filter(path => uiPath.test(path));
  if (!ui.length) return false;
  const diff = Bun.spawnSync(["git", "diff", "--unified=0", "--no-color", "--no-ext-diff", `${base}...${head}`, "--", ...ui], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (diff.exitCode !== 0) return false;
  const changed = diff.stdout.toString().split("\n").filter(line => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line));
  if (/^Binary files /m.test(diff.stdout.toString())) return false;
  return changed.length > 0 && changed.every(line => versionLine.test(line));
}

/** Read GitHub's event file; validate SHAs before passing them as argv, never shell text. */
export function checkUiPullRequest(eventPath: string, root = process.cwd()): UiEvidenceViolation[] {
  const event: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
  if (!record(event) || !record(event.pull_request)) return [];
  const pr = event.pull_request;
  const base = record(pr.base) ? pr.base.sha : undefined;
  const head = record(pr.head) ? pr.head.sha : undefined;
  if (typeof base !== "string" || typeof head !== "string" || !sha.test(base) || !sha.test(head)) return [{ rule: "UI-24", message: "Cannot validate PR evidence: invalid base/head SHA in GitHub event." }];
  // Match the PR diff: changes on the base branch are not changes introduced by the PR.
  const diff = Bun.spawnSync(["git", "diff", "--name-only", "-z", `${base}...${head}`, "--"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (diff.exitCode !== 0) return [{ rule: "UI-24", message: `Cannot inspect changed UI files; fetch the PR base/head history. git diff: ${diff.stderr.toString().trim()}` }];
  const files = diff.stdout.toString().split("\0").filter(Boolean);
  if (versionOnlyUiChange(files, base, head, root)) return [];
  // Only GitHub's explicit draft boolean relaxes readiness, never report content.
  // CI runs again on ready_for_review; absent/malformed metadata stays strict.
  return checkUiEvidence(files, typeof pr.body === "string" ? pr.body : "", base, head, pr.draft === true);
}
