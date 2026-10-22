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
export function AttachmentPicker({
  onFiles,
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  return (
    <label className="pc-attachment-picker">
      Attach files
      <TextInput
        type="file"
        multiple
        disabled={disabled}
        aria-label="Attach files"
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
