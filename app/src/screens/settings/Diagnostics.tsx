import {SettingsPath} from "./PathText";
import { recordDiagnostics } from "../../data/diagnostics-status";
import { diagnosticDetail, diagnosticNextStep, settingsText } from "./presentation";
import { NativeValidationSetup } from "./NativeValidation";
import { useState } from "preact/hooks";
import type { Check } from "../../../../src/install/doctor";
import { diagnosticBucket, diagnosticCategory, diagnosticGuidance, diagnosticEvidence, diagnosticGroups, diagnosticLevel, diagnosticRepair, diagnosticSetupLink, diagnosticTitle } from "../../../../src/view-model/diagnostics";
import { Button, ButtonLink } from "../../ds/Button";
import { Disclosure, SearchInput } from "../../ds/Controls";
import { SegmentedControl } from "../../ds/SelectionStrip";
import { DisclosurePanel } from "../../ds/Page";
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
    `${diagnosticLevel[check.level].label}: ${settingsText(diagnosticTitle(check.name))}${check.evidence ? ` · ${diagnosticEvidence[check.evidence]}` : ""}\n${diagnosticDetail(check)}${check.fix ? `\nSuggested next step: ${diagnosticNextStep(check.fix)}` : ""}\nTechnical details: ${check.detail}${check.fix ? `\nReported recovery instructions: ${check.fix}` : ""}`), REPORT_NOTE].join("\n\n");
}
const filters = [
  {value: 'attention', label: 'Needs attention'}, {value: 'all', label: 'All'},
  {value: 'failed', label: 'Failed'}, {value: 'passed', label: 'Passed'},
  {value: 'unchecked', label: 'Not checked'}, {value: 'information', label: 'Information'},
];
const priority = {failed: 0, attention: 1, unchecked: 2, information: 3, passed: 4};
export function DiagnosticResults({ report, busy = false, onRepair }: { report: DoctorReport; busy?: boolean; onRepair?: (agent: string) => void }) {
  const [filter, setFilter] = useState('attention');
  const [search, setSearch] = useState('');
  const groups = diagnosticGroups(report.checks);
  const query = search.trim().toLocaleLowerCase();
  const visible = report.checks.filter(check => {
    const bucket = diagnosticBucket(check);
    return (filter === 'all' || (filter === 'attention' ? bucket === 'attention' || bucket === 'failed' : bucket === filter)) &&
      (!query || [diagnosticTitle(check.name), diagnosticCategory(check, report.planner), diagnosticDetail(check), check.detail, check.fix].join(' ').toLocaleLowerCase().includes(query));
  }).sort((a, b) => priority[diagnosticBucket(a)] - priority[diagnosticBucket(b)]);
  const totals = [
    {tone: "good", count: groups.passed.length, label: "Passed"},
    {tone: "warn", count: report.checks.filter(check => check.level === "warn").length, label: "Needs attention"},
    {tone: "bad", count: report.checks.filter(check => check.level === "fail").length, label: "Failed"},
    {tone: "neutral", count: groups.unverified.length, label: "Not checked"},
  ] as const;
  const categories = ['Planner', 'Executors', 'Service'].map(name => ({name, checks: visible.filter(check => diagnosticCategory(check, report.planner) === name)}))
    .filter(group => group.checks.length)
    .sort((a, b) => priority[diagnosticBucket(a.checks[0]!)] - priority[diagnosticBucket(b.checks[0]!)]);
  return <div className="pc-diagnostic-results">
    <div className="pc-diagnostic-totals" aria-label="Check summary">{totals.map(total => <div key={total.label} className="pc-diagnostic-total" data-count={total.count}>
      <span aria-hidden="true" className={`pc-diagnostic-glyph pc-diagnostic-glyph--${total.tone}`}>{glyphs[total.tone]}</span>
      <span><b>{total.count}</b><span className="pc-diagnostic-caption">{total.label}</span></span>
    </div>)}</div>
    <div className="pc-diagnostic-controls">
      <SegmentedControl label="Filter checks" value={filter} onChange={setFilter} options={filters}/>
      <SearchInput label="Search checks" placeholder="Search checks" value={search} onInput={event => setSearch(event.currentTarget.value)}/>
    </div>
    <p className="pc-diagnostic-caption" role="status">Showing {visible.length} of {report.checks.length} checks{filter === 'attention' ? ' needing attention' : ''}.</p>
    {!visible.length && <p>{query ? 'No checks match this search and status. Change the filter or clear the search.' : filter === 'attention' ? 'No checks need attention. Choose All to review passed and not checked results.' : 'No checks have this status.'}</p>}
    {categories.map(({name, checks}) => <section key={name} aria-label={name} className="pc-diagnostic-group">
      <DisclosurePanel open summary={`${name} · ${checks.length}`}>
        <div className="pc-diagnostic-list">{checks.map((check, index) => {
          const repair = diagnosticRepair(check, report.repairAvailable ? report.planner : undefined);
          const attention = ['warn', 'fail'].includes(check.level);
          const setup = attention ? diagnosticSetupLink(check) : undefined;
          const bucket = diagnosticBucket(check);
          const tone = bucket === 'unchecked' ? 'neutral' : diagnosticLevel[check.level].tone;
          return <DiagnosticRow key={`${index}:${check.name}`} title={settingsText(diagnosticTitle(check.name))}
            caption={`${diagnosticDetail(check)}${check.evidence ? ` · ${diagnosticEvidence[check.evidence]}` : ''}`}
            tone={tone} glyph={glyphs[tone]} status={bucket === 'unchecked' ? 'Not checked' : diagnosticLevel[check.level].label}
            nextStep={attention || bucket === 'unchecked' ? `Next step: ${check.fix ? diagnosticNextStep(check.fix) : diagnosticGuidance(check)}` : undefined}
            action={repair && onRepair ? <Button size="sm" disabled={busy} onClick={() => onRepair(repair.agent)}>Repair<span className="sr-only"> {settingsText(diagnosticTitle(check.name))}</span></Button>
              : setup ? <ButtonLink size="sm" href={setup.href}>{setup.label}</ButtonLink> : undefined}>
            <pre>{check.detail}{check.fix ? `\n\nReported recovery instructions:\n${check.fix}` : ''}</pre>
          </DiagnosticRow>;
        })}</div>
      </DisclosurePanel>
    </section>)}
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
    const result = await action.run("doctor.run", {}, data => {setReport(timedReport(data, started)); recordDiagnostics(data.checks.filter((check: Check) => check.level === "fail" || check.level === "warn").length);});
    setProgress(result ? "" : "Checks failed. Try running checks again.");
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
      const refreshed = await readReport();
      setReport(refreshed);
      recordDiagnostics(refreshed.checks.filter(check => check.level === "warn" || check.level === "fail").length);
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
    <div role="status" aria-live="polite" id="diagnostics-progress" className={progress ? undefined : "sr-only"}>{progress}</div>
    <ErrorMessage error={action.error}/><ErrorMessage error={copyError}/>
    {preview && <section className="pc-card" aria-label="Repair preview" aria-busy={action.busy}>
      <SectionHeading>Review repair</SectionHeading>
      <p>Reconnect the selected planner integration. Review the files that will change before applying this repair.</p>
      <Disclosure className="pc-disclosure pc-disclosure--wrap" summary="Files and undo instructions">
        <ul>{preview.files.map(file => <li key={file}><SettingsPath path={file}/></li>)}</ul><p>You can disconnect the integration later from Budget &amp; pacing.</p>
      </Disclosure>
      <div className="u3-actions"><Button disabled={action.busy} onClick={() => void repair()}>Apply repair</Button>
        <Button variant="ghost" disabled={action.busy} onClick={() => {setPreview(undefined);setProgress("Repair cancelled. No changes were applied.");}}>Cancel</Button></div>
    </section>}
    {report && <div aria-busy={action.busy}><DiagnosticResults report={report} busy={action.busy} onRepair={agent => void previewRepair(agent)}/></div>}
    <NativeValidationSetup/>
  </section>;
}
