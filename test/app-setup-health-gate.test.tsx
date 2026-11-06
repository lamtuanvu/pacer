import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { SetupHealthStage } from "../app/src/screens/setup/SetupHealth";
import { setupHealthFailureReport } from "../app/src/screens/setup/SetupHealthGate";

test("setup.health rejection maps to a hard_fail gate that stays until Continue", () => {
  const report = setupHealthFailureReport("startup");
  expect(report.outcome).toBe("hard_fail");
  expect(report.steps.find(s => s.id === "service")?.state).toBe("failed");
  expect(report.steps.find(s => s.id === "service")?.detail).toContain("could not finish");
  expect(report.repairs?.[0]?.kind).toBe("open.diagnostics");
  const html = renderToString(
    <SetupHealthStage report={report} onContinue={() => {}} onOpenDiagnostics={() => {}} />,
  );
  expect(html).toContain("Continue anyway");
  expect(html).toContain("Open Diagnostics");
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("Continue to pacer");
});
