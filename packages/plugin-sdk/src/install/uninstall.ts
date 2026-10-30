import { sha256 } from "./helpers";
import { applyUndo, type PlannerRecord } from "./undo";
import type { PlanIO, PendingFile } from "./plan";
import type { PreparedPlannerPlan } from "./prepared";
export interface UninstallReport {
  planner: string;
  restored: string[];
  removed: string[];
  reverted: string[];
  notes: string[];
}
export interface PreparedPlannerUninstall extends PreparedPlannerPlan {
  uninstallReport: UninstallReport;
}
export interface UninstallPreparationFailure {
  path: string;
  reason: "missing_backup" | "occupied_destination" | "read_error";
}
/** Generic manifest-v1 file undo. Command/provider behavior belongs to a plugin.
 * onIncomplete reports local preparation failures independently of human notes;
 * it is never serialized into a candidate or used as filesystem authority.
 */
export async function preparePlannerUninstallFiles(
  io: PlanIO,
  prior: PlannerRecord,
  options: {
    onIncomplete?: (failure: UninstallPreparationFailure) => void;
  } = {},
): Promise<PreparedPlannerUninstall> {
  const record = structuredClone(prior),
    report: UninstallReport = {
      planner: record.planner,
      restored: [],
      removed: [],
      reverted: [],
      notes: [],
    },
    files: PendingFile[] = [];
  for (const file of [...record.files].reverse()) {
    try {
      const image = await io.read(file.path);
      if (file.action === "moved") {
        const backup = file.backup ? await io.read(file.backup) : null;
        if (backup && image === null) {
          files.push(
            {
              path: file.path,
              before: null,
              after: backup.text,
              mode: backup.mode & 0o700,
            },
            {
              path: file.backup!,
              before: backup.text,
              after: null,
              beforeMode: backup.mode & 0o700,
            },
          );
          report.restored.push(file.path);
        } else {
          options.onIncomplete?.({
            path: file.path,
            reason: backup ? "occupied_destination" : "missing_backup",
          });
          report.notes.push(
            `cannot restore ${file.path}; backup kept at ${file.backup}`,
          );
        }
        continue;
      }
      const text = image?.text ?? null,
        intact = text !== null && sha256(text) === file.afterHash;
      // Reconciliation refreshes afterHash even after unrelated user edits.
      // Shared files with lost exact ownership must keep their unmanaged pieces.
      // An intact opaque asset (no piece undo) remains wholly installer-owned.
      if (file.action === "created" && intact && (file.exact !== false || file.undo.length === 0)) {
        files.push({
          path: file.path,
          before: text,
          after: null,
          beforeMode: image!.mode & 0o700,
        });
        report.removed.push(file.path);
      } else if (
        file.action === "edited" &&
        intact &&
        file.exact &&
        file.backup
      ) {
        const backup = await io.read(file.backup);
        if (backup) {
          files.push(
            {
              path: file.path,
              before: text,
              after: backup.text,
              beforeMode: image!.mode & 0o700,
              mode: backup.mode & 0o700,
            },
            {
              path: file.backup,
              before: backup.text,
              after: null,
              beforeMode: backup.mode & 0o700,
            },
          );
          report.restored.push(file.path);
        } else {
          options.onIncomplete?.({ path: file.path, reason: "missing_backup" });
          if (text !== null && file.undo.length) {
            files.push({
              path: file.path,
              before: text,
              after: applyUndo(text, file.undo, report.notes),
              beforeMode: image!.mode & 0o700,
            });
            report.reverted.push(file.path);
          } else report.notes.push(`left ${file.path} unchanged`);
          report.notes.push(`backup kept at ${file.backup}`);
        }
      } else {
        if (text !== null && file.undo.length) {
          files.push({
            path: file.path,
            before: text,
            after: applyUndo(text, file.undo, report.notes),
            beforeMode: image!.mode & 0o700,
          });
          report.reverted.push(file.path);
        } else report.notes.push(`left ${file.path} unchanged`);
        if (file.backup) report.notes.push(`backup kept at ${file.backup}`);
      }
    } catch (error) {
      options.onIncomplete?.({ path: file.path, reason: "read_error" });
      report.notes.push(
        `cannot revert ${file.path}: ${error instanceof Error ? error.message : String(error)}${file.backup ? `; backup kept at ${file.backup}` : ""}`,
      );
    }
  }
  return {
    schema: 1,
    record,
    files,
    touched: [],
    notes: report.notes,
    uninstallReport: report,
  };
}
