---
name: live-validate
description: Validate runtime changes against a sandbox pacer service and affected live surfaces, recording CT-11 evidence.
---

Follow [the live validation procedure](../../../docs/testing/live-validation.md) from the repository root. It is the canonical guide for `bun run live`, surface selection, sandbox safety, real executor budget, evidence and teardown.

Read the applicable `.project/` rules. Exercise every affected behavior and surface, record `.work/live/<id>/evidence/report.md`, and summarize its verdicts in the result. Report unavailable surfaces as UNVERIFIED; never infer a live pass from unit tests. Never delegate into the user's checkout or use the real `~/.pacer` for validation.
