import { NativeValidationSetup } from "./NativeValidation";
import { useState } from "preact/hooks";
import type { Check } from "../../../../src/install/doctor";
import { diagnosticEvidence, diagnosticGroups, diagnosticLevel, diagnosticRepair, diagnosticSetupLink, diagnosticTitle } from "../../../../src/view-model/diagnostics";
import { Button, ButtonLink } from "../../ds/Button";
import { Disclosure } from "../../ds/Controls";
import { DiagnosticRow } from "../../ds/DiagnosticRow";
import { SectionHeading } from "../../ds/SectionHeading";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { time, useOperation, useSettingsStyles } from "./shared";

export interface DoctorReport { checkedAt: number; durationSeconds?: number; checks: Check[]; planner?: string; repairAvailable?: boolean }
interface RepairPreview { revision: string; agent: string; files: string[]; undo: string; detail?: string }

const REPORT_NOTE = "Configuration and fixture tests do not prove hook invocation. It stays unverified until observed in the planner.";
const glyphs = {good: "✓", warn: "!", bad: "✕", neutral: "–"} as const;
function diagnosticTiming(report: DoctorReport): string {
  const checked = time(report.checkedAt);
  return `Last run ${/^\d{2}:\d{2}$/.test(checked) ? `today ${checked}` : checked}${report.durationSeconds != null ? ` · took ${report.durationSeconds < 1 ? "<1" : Math.round(report.durationSeconds)}s` : ""}`;
}
export function diagnosticReportText(report: DoctorReport): string {
  return [`Diagnostics · ${diagnosticTiming(report)}`, ...report.checks.map(check =>
    `${diagnosticLevel[check.level].label}: ${diagnosticTitle(check.name)}${check.evidence ? ` · ${diagnosticEvidence[check.evidence]}` : ""}\n${check.detail}${check.fix ? `\nSuggested next step: ${check.fix}` : ""}`), REPORT_NOTE].join("\n\n");
}
function reportGroup(check: Check, planner?: string) {
  if (check.name.startsWith("Claude ") || check.name === "Legacy guard" ||
      planner && ["Install", "Skill"].some(prefix => check.name === `${prefix} ${planner}`)) return "Planner";
  if (/^(Binary|CLI|Login|Usage|Install|Skill) /.test(check.name) || check.name === "Executor") return "Executors";
  return "Service";
}
export function DiagnosticResults({ report, busy = false, onRepair }: { report: DoctorReport; busy?: boolean; onRepair?: (agent: string) => void }) {
  const groups = diagnosticGroups(report.checks);
  const issues = groups.issues.flatMap(group => group.checks);
  const totals = [
    {tone: "good", count: groups.passed.length, label: "Passed"},
    {tone: "warn", count: issues.filter(check => check.level === "warn").length, label: "Need a look"},
    {tone: "bad", count: issues.filter(check => check.level === "fail").length, label: "Failed"},
    {tone: "neutral", count: groups.unverified.length, label: "Not checked"},
  ] as const;
  return <div className="pc-diagnostic-results">
    <div className="pc-diagnostic-totals" aria-label="Check summary">{totals.map(total => <div key={total.label} className="pc-diagnostic-total" data-count={total.count}>
      <span aria-hidden="true" className={`pc-diagnostic-glyph pc-diagnostic-glyph--${total.tone}`}>{glyphs[total.tone]}</span>
      <span><b>{total.count}</b><span className="pc-diagnostic-caption">{total.label}</span></span>
    </div>)}</div>
    {["Planner", "Executors", "Service"].map(name => {
      const checks = report.checks.filter(check => reportGroup(check, report.planner) === name);
      return !!checks.length && <section key={name} aria-label={name} className="pc-diagnostic-group">
        <SectionHeading>{name}</SectionHeading><div className="pc-diagnostic-list">{checks.map((check, index) => {
          const repair = diagnosticRepair(check, report.repairAvailable ? report.planner : undefined);
          const setup = ["warn", "fail"].includes(check.level) ? diagnosticSetupLink(check) : undefined;
          const tone = check.evidence === "unverified" && !["warn", "fail"].includes(check.level) ? "neutral" : diagnosticLevel[check.level].tone;
          return <DiagnosticRow key={`${index}:${check.name}`} title={diagnosticTitle(check.name)}
            caption={`${check.detail}${check.evidence ? ` · ${diagnosticEvidence[check.evidence]}` : ""}`}
            tone={tone} glyph={glyphs[tone]} status={diagnosticLevel[check.level].label} open={check.level === "fail"}
            action={repair && onRepair ? <Button size="sm" disabled={busy} onClick={() => onRepair(repair.agent)}>Repair<span className="sr-only"> {diagnosticTitle(check.name)}</span></Button>
              : setup ? <ButtonLink size="sm" href={setup.href}>{setup.label}</ButtonLink> : undefined}>
            <pre>{check.name}{"\n"}{check.detail}{check.fix && `\n\nSuggested next step\n${check.fix}`}</pre>
          </DiagnosticRow>;
        })}</div>
      </section>;
    })}
  </div>;
}
export function DiagnosticsSection() {
  useSettingsStyles();
  const {api} = useTaskContext();
  const [report, setReport] = useState<DoctorReport>();
  const [copyError, setCopyError] = useState<unknown>();
  const [preview, setPreview] = useState<RepairPreview>();
  const [progress, setProgress] = useState("No checks run yet.");
  const action = useOperation(undefined, {notifySuccess: false});
  function timedReport(report: DoctorReport, started: number) {
    return { ...report, durationSeconds: (performance.now() - started) / 1000 };
  }
  async function readReport() {
    const started = performance.now();
    return timedReport(await api.call<DoctorReport>("doctor.run", {}), started);
  }
  async function runChecks() {
    setPreview(undefined);
    setProgress("Running checks…");
    const started = performance.now();
    const result = await action.run("doctor.run", {}, data => setReport(timedReport(data, started)));
    setProgress(result ? "Checks complete." : "Checks failed. Try running checks again.");
  }
  async function previewRepair(agent: string) {
    setPreview(undefined);
    setProgress("Loading repair preview…");
    const result = await action.run("agent.preview", {agent}, data => setPreview(data));
    setProgress(result ? "Review the repair below before applying changes." : "Repair preview failed. No changes were applied.");
  }
  async function repair() {
    if (!preview) return;
    setProgress("Repairing integration…");
    const result = await action.run("agent.connect", {agent: preview.agent, consent: true, preview_revision: preview.revision}, async () => {
      setPreview(undefined);
      setProgress("Repair applied. Rechecking…");
      setReport(await readReport());
    });
    if (!result) setPreview(undefined);
    setProgress(result ? "Repair applied and checks refreshed. Review any remaining issues." : "Repair or recheck failed. Review the error and run checks again.");
  }
  async function copyReport() {
    if (!report) return;
    setCopyError(undefined);
    try { await navigator.clipboard.writeText(diagnosticReportText(report)); setProgress("Report copied."); }
    catch (error) { setCopyError(error); setProgress("Could not copy the report."); }
  }
  return <section id="diagnostics" aria-label="Diagnostics" className="pc-diagnostics">
    <header className="pc-diagnostics-header">
      <div><h1>Diagnostics</h1><p className="pc-diagnostic-caption">Checks that pacer, your planner and every executor are wired up.{report && ` ${diagnosticTiming(report)}.`}</p></div>
      {report && <Button onClick={() => void copyReport()}>Copy report</Button>}
      <Button variant="primary" disabled={action.busy} aria-describedby={action.busy ? "diagnostics-progress" : undefined}
        onClick={() => void runChecks()}>Run all checks</Button>
    </header>
    <div role="status" aria-live="polite" id="diagnostics-progress">{progress}</div>
    <ErrorMessage error={action.error}/><ErrorMessage error={copyError}/>
    {preview && <section className="pc-card" aria-label="Repair preview" aria-busy={action.busy}>
      <SectionHeading>Review repair</SectionHeading>
      <p>Reconnect the selected planner integration. Review the files that will change before applying this repair.</p>
      <Disclosure className="pc-disclosure pc-disclosure--wrap" summary="Files and undo instructions">
        <pre>{preview.files.join("\n")}</pre>{preview.detail && <pre>{preview.detail}</pre>}<pre>{preview.undo}</pre>
      </Disclosure>
      <div className="u3-actions"><Button disabled={action.busy} onClick={() => void repair()}>Apply repair</Button>
        <Button variant="ghost" disabled={action.busy} onClick={() => {setPreview(undefined);setProgress("Repair cancelled. No changes were applied.");}}>Cancel</Button></div>
    </section>}
    {report && <div aria-busy={action.busy}><p className="pc-diagnostic-caption" role="note">{REPORT_NOTE}</p><DiagnosticResults report={report} busy={action.busy} onRepair={agent => void previewRepair(agent)}/></div>}
    <NativeValidationSetup/>
  </section>;
}
