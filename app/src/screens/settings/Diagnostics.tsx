import { useState } from "preact/hooks";
import type { Check } from "../../../../src/install/doctor";
import { diagnosticEvidence, diagnosticLevel, diagnosticTitle } from "../../../../src/view-model/diagnostics";
import { Button } from "../../ds/Button";
import { Disclosure } from "../../ds/Controls";
import { Pill } from "../../ds/Pill";
import { ErrorMessage } from "../task-shared";
import { Section, time, useOperation } from "./shared";

export interface DoctorReport { checkedAt: number; checks: Check[] }
export function DiagnosticResults({ report }: { report: DoctorReport }) {
  return <>
    <p>Checked {time(report.checkedAt)}. Expand for details and repair guidance.</p>
    <ul className="u3-checks">{report.checks.map((check, index) => <li key={`${index}:${check.name}`}>
      <Disclosure className="pc-disclosure pc-disclosure--wrap" summary={<>
        <span className="pc-ellipsis" title={diagnosticTitle(check.name)}>{diagnosticTitle(check.name)}</span><Pill tone={diagnosticLevel[check.level].tone}>{diagnosticLevel[check.level].label}</Pill>
        {check.evidence && <span>{diagnosticEvidence[check.evidence]}</span>}
      </>}>
        <pre>{check.name}{"\n"}{check.detail}</pre>
        {check.fix && <><strong>Suggested next step</strong><pre>{check.fix}</pre></>}
      </Disclosure>
    </li>)}</ul>
  </>;
}
export function DiagnosticsSection() {
  const [report, setReport] = useState<DoctorReport>();
  const action = useOperation();
  return <Section id="diagnostics" title="Diagnostics" detail="Check setup, service, accounts and integrations without changing installations."
    actions={<Button disabled={action.busy} aria-describedby={action.busy ? "diagnostics-progress" : undefined}
      onClick={() => void action.run("doctor.run", {}, data => setReport(data))}>{action.busy ? "Running checks…" : "Run checks"}</Button>}>
    <p>Configuration and fixture tests do not prove Claude fired a hook. Host invocation is unverified until observed in Claude.</p>
    <div role="status" aria-live="polite" id="diagnostics-progress">{action.busy ? "Checks are running; wait to rerun." : report ? "Checks complete." : "No checks run yet."}</div>
    <ErrorMessage error={action.error}/>
    {report && <div aria-busy={action.busy}><DiagnosticResults report={report}/></div>}
  </Section>;
}
