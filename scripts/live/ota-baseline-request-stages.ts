/** Hash-guarded, opt-in diagnostic derivative of the published 0.2.3 source. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout } from "./core";

type Edit = readonly [before: string, after: string];
const hashes = {
  "src/serve/http.ts": "cb653d23d3a280f9a7aed3a7ba0ee7f8622769343c7ff2f2188851cca1045b5f",
  "src/api/http.ts": "4b3fce01626a96ca1b31f9923411f61db0eebf144cd8145892eb76d2be6ed0fd",
  "src/update/desktop/adoption-service.ts": "e2d08571dc1fac815e02fffc5cdf1774be10ecefda26e9e4ffc7b5da8a55c9c7",
} as const;
const importRecorder = 'import { recordBaselineRequestStage } from "../update/desktop/fixture-request-stage";\n';
const serverEdits: Edit[] = [
  ["import { superviseTasks } from \"../tasks/api\";\n", importRecorder + "import { superviseTasks } from \"../tasks/api\";\n"],
  ["      const { pathname } = new URL(req.url);\n      const sessionRoute", "      const { pathname } = new URL(req.url);\n      if (req.method === \"POST\" && pathname === \"/v3/ops/desktop.update.adopt\") recordBaselineRequestStage(\"request-arrival\");\n      const sessionRoute"],
];
const apiEdits: Edit[] = [
  ["import { toV2Snapshot, V2_PROTOCOL, callV2Op, v2Hello } from \"./v2-compat\";\n", importRecorder + "import { toV2Snapshot, V2_PROTOCOL, callV2Op, v2Hello } from \"./v2-compat\";\n"],
  ["  const tailMs = deps.tailMs ?? 1_000;", "  if (pathname === \"/v2/ops/desktop.update.adopt\") recordBaselineRequestStage(\"api-entry\");\n  const tailMs = deps.tailMs ?? 1_000;"],
  ["      const result = pathname === \"/v2/ops/routing.status\"", "      if (pathname === \"/v2/ops/desktop.update.adopt\") recordBaselineRequestStage(\"route-dispatch\");\n      const result = pathname === \"/v2/ops/routing.status\""],
];
const adoptionEdits: Edit[] = [
  ["import { sameProcess } from \"./process-identity\";\n", "import { recordBaselineRequestStage, type BaselineRequestStage } from \"./fixture-request-stage\";\nimport { sameProcess } from \"./process-identity\";\n"],
  ["  const cancelWaiting = async (value: AdoptionRecord) => {", "  const cancelWaiting = async (value: AdoptionRecord, reason: BaselineRequestStage) => {"],
  ["      change(current, \"cancelled\");\n      await gate.releaseReservation", "      recordBaselineRequestStage(reason);\n      change(current, \"cancelled\");\n      await gate.releaseReservation"],
  ["if (value.phase === \"waiting\") await cancelWaiting(value);", "if (value.phase === \"waiting\") await cancelWaiting(value, \"cancel-startup\");"],
  ["if (!s || !permitted(s, value)) {\n            await cancelWaiting(value);", "if (!s || !permitted(s, value)) {\n            await cancelWaiting(value, !s ? \"cancel-no-session\" : \"cancel-not-permitted\");"],
  ["          } catch {\n            await cancelWaiting(value);", "          } catch {\n            await cancelWaiting(value, \"cancel-reverify\");"],
  ["if (stopped || !s.alive() || !permitted(s, current)) {\n            await cancelWaiting(current);", "if (stopped || !s.alive() || !permitted(s, current)) {\n            await cancelWaiting(current, \"cancel-after-reserve\");"],
  ["    async adopt(input: UpdateRequest) {\n      if (stopped)", "    async adopt(input: UpdateRequest) {\n      recordBaselineRequestStage(\"adopt-entry\");\n      if (stopped)"],
  ["      const replay = replayAdoptionRequest(getCtx(), input);\n      if (replay)", "      recordBaselineRequestStage(\"replay-enter\");\n      const replay = replayAdoptionRequest(getCtx(), input);\n      recordBaselineRequestStage(\"replay-exit\");\n      if (replay)"],
  ["      if (!s) throw unavailable();\n      await deps.native.reverify(s);\n      if (!s.alive())", "      if (!s) throw unavailable();\n      recordBaselineRequestStage(\"reverify-enter\");\n      await deps.native.reverify(s);\n      recordBaselineRequestStage(\"reverify-exit\");\n      if (!s.alive())"],
  ["      const next = beginAdoption(\n", "      recordBaselineRequestStage(\"begin-enter\");\n      const next = beginAdoption(\n"],
  ["      deps.changed?.(next);\n      return next;\n    },\n    async cancel", "      recordBaselineRequestStage(\"begin-exit\");\n      deps.changed?.(next);\n      return next;\n    },\n    async cancel"],
];

export function applyStageEdits(source: string, expectedSha256: string, edits: readonly Edit[]): string {
  if (createHash("sha256").update(source).digest("hex") !== expectedSha256) throw Error("Published baseline source changed");
  let result = source;
  for (const [before, after] of edits) {
    if (!before || result.split(before).length !== 2) throw Error("Baseline diagnostic anchor changed");
    result = result.replace(before, after);
  }
  return result;
}

/** Returns null for the byte-for-byte published control; diagnostics are opt-in. */
export function overlayPublishedBaseline(root: string, enabled: boolean): { moduleSha256: string } | null {
  if (!enabled) return null;
  const planned = [
    ["src/serve/http.ts", serverEdits],
    ["src/api/http.ts", apiEdits],
    ["src/update/desktop/adoption-service.ts", adoptionEdits],
  ] as const;
  const changes = planned.map(([name, edits]) => {
    const path = join(root, name);
    return [path, applyStageEdits(readFileSync(path, "utf8"), hashes[name], edits)] as const;
  });
  const source = join(checkout, "src/update/desktop/fixture-request-stage.ts");
  const destination = join(root, "src/update/desktop/fixture-request-stage.ts");
  if (existsSync(destination)) throw Error("Published baseline already contains diagnostic module");
  const moduleSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
  for (const [path, body] of changes) writeFileSync(path, body);
  copyFileSync(source, destination);
  return { moduleSha256 };
}
