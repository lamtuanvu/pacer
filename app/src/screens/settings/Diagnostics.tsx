import { NativeValidationSetup } from "./NativeValidation";
import { useState } from "preact/hooks";
import type { Check } from "../../../../src/install/doctor";
import { diagnosticEvidence, diagnosticGroups, diagnosticGuidance, diagnosticLevel, diagnosticRepair, diagnosticSetupLink, diagnosticTitle } from "../../../../src/view-model/diagnostics";
import { Button, TextAction } from "../../ds/Button";
import { Disclosure } from "../../ds/Controls";
import { Pill } from "../../ds/Pill";
import { SectionHeading } from "../../ds/SectionHeading";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { SettingRow } from "../../ds/SettingRow";
import { Section, time, useOperation } from "./shared";

export interface DoctorReport { checkedAt: number; checks: Check[]; planner?: string; repairAvailable?: boolean }
interface RepairPreview { revision: string; agent: string; files: string[]; undo: string; detail?: string }

function TechnicalDetails({ check }: { check: Check }) {
  return <Disclosure className="pc-disclosure pc-disclosure--wrap" summary="Technical details">
    <pre>{check.name}{"\n"}{check.detail}</pre>
    {check.fix && <><strong>Suggested next step</strong><pre>{check.fix}</pre></>}
  </Disclosure>;
}
function CheckList({ checks }: { checks: Check[] }) {
  return <ul className="u3-checks">{checks.map((check, index) => <li key={`${index}:${check.name}`}>
    <div className="u3-actions"><span>{diagnosticTitle(check.name)}</span><Pill tone={diagnosticLevel[check.level].tone}>{diagnosticLevel[check.level].label}</Pill>
      {check.evidence && <span>{diagnosticEvidence[check.evidence]}</span>}</div>
    <TechnicalDetails check={check}/>
  </li>)}</ul>;
}
export function DiagnosticResults({ report, busy = false, onRepair }: { report: DoctorReport; busy?: boolean; onRepair?: (agent: string) => void }) {
  const groups = diagnosticGroups(report.checks);
  return <div className="u3-diagnostics">
    <div className="u3-actions" aria-label="Check summary">
      <Pill tone={groups.issueCount ? "warn" : "good"}>{groups.issueCount} {groups.issueCount === 1 ? "issue" : "issues"}</Pill>
      <span>{groups.passed.length} passed</span><span>{groups.unverifiedCount} unverified</span>
      <span className="u3-muted">Checked {time(report.checkedAt)}</span>
    </div>
    {groups.issues.length ? <><SectionHeading>Needs attention</SectionHeading>
      {groups.issues.map(group => <section className="pc-card" aria-label={`${group.title} issues`} key={group.title}>
        <SectionHeading as="h3">{group.title}</SectionHeading>
        {group.checks.map((check, index) => {
          const repair = diagnosticRepair(check, report.repairAvailable ? report.planner : undefined), setup = diagnosticSetupLink(check);
          return <div key={`${index}:${check.name}`}>
            <div className="u3-actions"><strong>{diagnosticTitle(check.name)}</strong><Pill tone={diagnosticLevel[check.level].tone}>{diagnosticLevel[check.level].label}</Pill></div>
            <p>{diagnosticGuidance(check)}</p>
            {check.evidence && <p>{diagnosticEvidence[check.evidence]}</p>}
            <div className="u3-actions">{repair && onRepair
              ? <Button disabled={busy} onClick={() => onRepair(repair.agent)}>Repair<span className="sr-only"> {diagnosticTitle(check.name)}</span></Button>
              : setup && <TextAction href={setup.href}>{setup.label}</TextAction>}</div>
            <TechnicalDetails check={check}/>
          </div>;
        })}
      </section>)}</> : <p>No issues found in these checks.</p>}
    {!!groups.unverified.length && <section aria-label="Unverified checks"><SectionHeading>Unverified checks</SectionHeading>
      <p>Configuration and fixture tests do not prove live invocation. Confirm these checks in the intended agent session.</p>
      <CheckList checks={groups.unverified}/></section>}
    {!!groups.passed.length && <Disclosure className="pc-disclosure pc-disclosure--wrap" summary="Passed checks"><CheckList checks={groups.passed}/></Disclosure>}
    {!!groups.information.length && <Disclosure className="pc-disclosure pc-disclosure--wrap" summary="Other information"><CheckList checks={groups.information}/></Disclosure>}
  </div>;
}
export function DiagnosticsSection() {
  const {api} = useTaskContext();
  const [report, setReport] = useState<DoctorReport>();
  const [preview, setPreview] = useState<RepairPreview>();
  const [progress, setProgress] = useState("No checks run yet.");
  const action = useOperation(undefined, {notifySuccess: false});
  async function runChecks() {
    setPreview(undefined);
    setProgress("Running checks…");
    const result = await action.run("doctor.run", {}, data => setReport(data));
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
      setReport(await api.call<DoctorReport>("doctor.run", {}));
    });
    if (!result) setPreview(undefined);
    setProgress(result ? "Repair applied and checks refreshed. Review any remaining issues." : "Repair or recheck failed. Review the error and run checks again.");
  }
  return <Section id="diagnostics" title="Diagnostics">
    <SettingRow label="Setup checks" description="Check setup and repair supported integrations.">
      <Button variant="primary" disabled={action.busy} aria-describedby={action.busy ? "diagnostics-progress" : undefined}
        onClick={() => void runChecks()}>{action.busy ? "Working…" : "Run checks"}</Button>
    </SettingRow>
    {!report && <p>Configuration and fixture tests do not prove hook invocation. It stays unverified until observed in Claude.</p>}
    <div role="status" aria-live="polite" id="diagnostics-progress">{progress}</div>
    <ErrorMessage error={action.error}/>
    {preview && <section className="pc-card" aria-label="Repair preview" aria-busy={action.busy}>
      <SectionHeading>Review repair</SectionHeading>
      <p>Reconnect the selected planner integration. Review the files that will change before applying this repair.</p>
      <Disclosure className="pc-disclosure pc-disclosure--wrap" summary="Files and undo instructions">
        <pre>{preview.files.join("\n")}</pre>{preview.detail && <pre>{preview.detail}</pre>}<pre>{preview.undo}</pre>
      </Disclosure>
      <div className="u3-actions"><Button disabled={action.busy} onClick={() => void repair()}>Apply repair</Button>
        <Button variant="ghost" disabled={action.busy} onClick={() => {setPreview(undefined);setProgress("Repair cancelled. No changes were applied.");}}>Cancel</Button></div>
    </section>}
    {report && <div aria-busy={action.busy}><DiagnosticResults report={report} busy={action.busy} onRepair={agent => void previewRepair(agent)}/></div>}
    <NativeValidationSetup/>
  </Section>;
}
