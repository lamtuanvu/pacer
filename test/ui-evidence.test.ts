import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUiPullRequest, checkUiEvidence } from "../scripts/ui-check-evidence";
import { parse } from "yaml";

const base = "a".repeat(40), head = "b".repeat(40);
const report = (name: string) => ({ verdict: "PASS", report: `https://github.com/example/pacer/pull/191#issuecomment-${name}`, summary: "Checked applicable rules and attached actual evidence." });
const evidence = () => ({ version: 1, base, head, compliance: report("1"), ui: report("2"), qa: report("3") });
const body = (value: unknown) => `## How tested\n<!-- pacer-ui-evidence\n${JSON.stringify(value)}\n-->`;

describe("UI PR evidence manifest", () => {
  test.each(["app/src/term/term.tsx", "app/src/tray/tray.css", "src/dashboard/render.ts", "src/render/table.ts", "src/view-model/words.ts", "orca-plugin/src/panel/board.ts", "desktop/src-tauri/src/main.rs"])("requires real report references for %s", file => {
    expect(checkUiEvidence([file], "- [x] UI reviewed; QA passed", base, head)).not.toEqual([]);
    expect(checkUiEvidence([file], body(evidence()), base, head)).toEqual([]);
  });
  test.each([
    "desktop/ui/index.html", "desktop/ui/shell.css", "desktop/ui/shell.js", "desktop/ui/shell.ts", "desktop/ui/View.tsx",
    "desktop/ui/mark.svg", "desktop/ui/fonts/body.woff2", "desktop/src-tauri/icons/tray.png",
    "desktop/src-tauri/icons/icon.icns", "desktop/src-tauri/icons/icon.ico",
    "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/tauri.linux.conf.json",
  ])("requires evidence for desktop presentation path %s", path => {
    expect(checkUiEvidence([path], "", base, head).some(v => v.rule === "UI-24")).toBe(true);
    expect(checkUiEvidence([path], body(evidence()), base, head)).toEqual([]);
  });

  test("validates event SHAs before git and ignores push events", () => {
    const directory = mkdtempSync(join(tmpdir(), "pacer-ui-event-")), path = join(directory, "event.json");
    try {
      writeFileSync(path, JSON.stringify({ ref: "refs/heads/main" }));
      expect(checkUiPullRequest(path)).toEqual([]);
      writeFileSync(path, JSON.stringify({ pull_request: { base: { sha: "--output=unsafe" }, head: { sha: head }, body: body(evidence()) } }));
      expect(checkUiPullRequest(path)).toEqual([{ rule: "UI-24", message: "Cannot validate PR evidence: invalid base/head SHA in GitHub event." }]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test.each(["Café.tsx", 'Line\nBreak.tsx', 'Quoted"File.tsx'])("G5 recognizes real Git changed path %s", filename => {
    const root = mkdtempSync(join(tmpdir(), "pacer-ui-git-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${root}/no-hooks`, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode) throw Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      git("init", "--quiet"); git("commit", "--allow-empty", "-m", "test: fixture base");
      const reviewedBase = git("rev-parse", "HEAD");
      mkdirSync(join(root, "app/src/screens"), { recursive: true });
      writeFileSync(join(root, "app/src/screens", filename), "export const X = () => <div />;");
      git("add", "--all"); git("commit", "-m", "test: fixture UI change");
      const reviewedHead = git("rev-parse", "HEAD"), event = join(root, "event.json");
      const writeEvent = (prBody: string, draft?: unknown, action = "edited") => writeFileSync(event, JSON.stringify({ action, pull_request: { draft, base: { sha: reviewedBase }, head: { sha: reviewedHead }, body: prBody } }));
      writeEvent("");
      expect(checkUiPullRequest(event, root).some(v => v.rule === "UI-24")).toBe(true);
      writeEvent(body({ ...evidence(), base: reviewedBase, head: reviewedHead }));
      expect(checkUiPullRequest(event, root)).toEqual([]);
      const incomplete = { ...evidence(), base: reviewedBase, head: reviewedHead };
      incomplete.ui.verdict = "UNVERIFIED";
      incomplete.ui.summary = "Native desktop validation remains UNVERIFIED.";
      writeEvent(body(incomplete), true);
      expect(checkUiPullRequest(event, root)).toEqual([]);
      for (const draft of [false, undefined, "true"]) {
        writeEvent(body(incomplete), draft, "ready_for_review");
        expect(checkUiPullRequest(event, root).length).toBeGreaterThan(0);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("docs-only/test-only/CI-only changes do not require UI manifests", () => {
    expect(checkUiEvidence(["docs/design-system.md", "test/app-ui.test.tsx", ".project/rules/ui.md", ".github/workflows/ci.yml", "app/README.md", "desktop/README.md", "desktop/src-tauri/capabilities/README.md", "desktop/src-tauri/Cargo.lock", "desktop/bun.lock"], "")).toEqual([]);
  });
  test("requires all three reports and their summaries", () => {
    for (const key of ["compliance", "ui", "qa"] as const) {
      const value = evidence(); delete (value as Partial<typeof value>)[key];
      expect(checkUiEvidence(["app/src/app.tsx"], body(value))).not.toEqual([]);
      const empty = evidence(); empty[key].summary = "";
      expect(checkUiEvidence(["app/src/app.tsx"], body(empty))).not.toEqual([]);
    }
  });
  test.each(["FAIL", "UNVERIFIED", "UNKNOWN"])("does not accept %s as completed review evidence", verdict => {
    const value = evidence(); value.ui.verdict = verdict;
    expect(checkUiEvidence(["app/src/app.tsx"], body(value))).not.toEqual([]);
  });
  test("does not hide an unverified surface in a PASS summary", () => {
    const value = evidence(); value.qa.summary = "Desktop keyboard navigation UNVERIFIED";
    expect(checkUiEvidence(["app/src/app.tsx"], body(value))).not.toEqual([]);
    expect(checkUiEvidence(["app/src/app.tsx"], body(value), base, head, true)).not.toEqual([]);
  });
  test.each(["FAIL", "UNVERIFIED"])("draft reports may honestly record %s without claiming readiness", verdict => {
    const value = evidence(); value.ui.verdict = verdict;
    value.ui.summary = `Native validation is ${verdict}; details are in the report.`;
    expect(checkUiEvidence(["app/src/app.tsx"], body(value), base, head, true)).toEqual([]);
    expect(checkUiEvidence(["app/src/app.tsx"], body(value), base, head, false)).not.toEqual([]);
    value.ui.report = ".work/reviews/ui.md";
    expect(checkUiEvidence(["app/src/app.tsx"], body(value), base, head, true)).not.toEqual([]);
  });
  test("draft status does not excuse missing, stale or invalid reports", () => {
    expect(checkUiEvidence(["app/src/app.tsx"], "", base, head, true)).not.toEqual([]);
    const value = evidence(); value.ui.verdict = "UNKNOWN";
    expect(checkUiEvidence(["app/src/app.tsx"], body(value), base, head, true)).not.toEqual([]);
    expect(checkUiEvidence(["app/src/app.tsx"], body({ ...value, ui: { ...value.ui, verdict: ["UNVERIFIED"] } }), base, head, true)).not.toEqual([]);
    expect(checkUiEvidence(["app/src/app.tsx"], body(evidence()), base, "c".repeat(40), true)).not.toEqual([]);
    value.ui.verdict = "UNVERIFIED"; value.ui.summary = "";
    expect(checkUiEvidence(["app/src/app.tsx"], body(value), base, head, true)).not.toEqual([]);
  });
  test("CI rechecks readiness when the PR leaves draft and when it returns to draft", () => {
    const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const events = workflow.on.pull_request.types;
    expect(events).toContain("ready_for_review");
    expect(events).toContain("converted_to_draft");
  });
  test.each(["", ".work/reviews/ui.md", "review done", "https://example.com", "javascript:alert(1)", "file:///tmp/report", "artifact://"])("rejects inaccessible or nonspecific reference %s", reference => {
    const value = evidence(); value.ui.report = reference;
    expect(checkUiEvidence(["app/src/app.tsx"], body(value))).not.toEqual([]);
  });
  test("accepts concrete artifact references and checks reviewed base/head", () => {
    const value = evidence(); value.ui.report = "artifact://ui-review-191/report.md";
    expect(checkUiEvidence(["app/src/app.tsx"], body(value), base, head)).toEqual([]);
    expect(checkUiEvidence(["app/src/app.tsx"], body(value), base, "c".repeat(40))).not.toEqual([]);
  });
  test("rejects malformed, duplicate, invalid-version and non-object manifest", () => {
    for (const value of ["<!-- pacer-ui-evidence\nnot JSON\n-->", body(null), body([]), body({ ...evidence(), version: 2 }), body(evidence()) + body(evidence())]) {
      expect(checkUiEvidence(["app/src/app.tsx"], value)).not.toEqual([]);
    }
  });
});
