import type { ComponentChildren } from "preact";
import { Button } from "./Button";
import { TextInput } from "./Controls";
export interface AttachmentItem {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  preview?: string;
  removable?: boolean;
}
/** `tool` renders a quiet toolbar trigger (composer toolbars); `label` and `accessibleLabel` replace the default words. */
export function AttachmentPicker({
  onFiles,
  disabled = false,
  variant = "default",
  label = "Attach files",
  accessibleLabel = "Attach files",
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  variant?: "default" | "tool";
  label?: ComponentChildren;
  accessibleLabel?: string;
}) {
  return (
    <label className={variant === "tool" ? "pc-attachment-picker pc-attachment-picker--tool" : "pc-attachment-picker"}>
      <span className="pc-attachment-picker__trigger">{label}</span>
      <TextInput
        type="file"
        multiple
        disabled={disabled}
        aria-label={accessibleLabel}
        onChange={(event) => {
          onFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}
export function AttachmentTray({
  items,
  onRemove,
  onRetry,
}: {
  items: AttachmentItem[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <ul className="pc-attachments" aria-label="Attachments">
      {items.map((item) => (
        <li key={item.id}>
          {item.preview && <img src={item.preview} alt="" />}
          <span className="pc-attachment-name" title={item.name}>
            {item.name}
            <small>
              {Math.ceil(item.size / 1024)} KB ·{" "}
              {item.status === "uploading"
                ? "Uploading…"
                : item.status === "error"
                  ? (item.error ?? "Upload failed")
                  : "Ready"}
            </small>
          </span>
          {item.status === "error" && (
            <Button size="sm" onClick={() => onRetry(item.id)}>
              Retry
            </Button>
          )}
          {item.status !== "uploading" && item.removable !== false && (
            <Button
              size="sm"
              variant="quiet"
              aria-label={`Remove ${item.name}`}
              onClick={() => onRemove(item.id)}
            >
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
