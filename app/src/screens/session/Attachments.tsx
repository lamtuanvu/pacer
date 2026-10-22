import { useState } from "preact/hooks";
import { Button } from "../../ds/Button";
import { AttachmentPicker, AttachmentTray } from "../../ds/AttachmentTray";
import { useAttachments } from "../../model/attachments";
import { ErrorMessage, useTaskContext } from "../task-shared";
export function AttachmentDelivery({
  name,
  text,
  onCopy,
}: {
  name: string;
  text: string;
  onCopy: () => void;
}) {
  return (
    <div className="pc-conversation-delivery">
      <strong>{name}</strong>
      <p>Paste into the agent’s input, then submit when ready.</p>
      <code className="pc-code-scroll" tabIndex={0}>
        {text}
      </code>
      <Button size="sm" onClick={onCopy}>
        Copy reference
      </Button>
    </div>
  );
}
export function SessionAttachments({
  id,
  draftId,
  active,
  uploads,
}: {
  id: string;
  draftId: string;
  active: boolean;
  uploads: ReturnType<typeof useAttachments>;
}) {
  const { api } = useTaskContext();
  const [deliveries, setDeliveries] = useState<Record<string, string>>({}),
    [error, setError] = useState<unknown>(),
    [notice, setNotice] = useState("");
  const prepare = async (attachmentId: string) => {
    setError(undefined);
    try {
      const result = await api.call<{
        kind: string;
        text?: string;
        reason?: string;
      }>("session.attachment.prepare", { id, attachmentId });
      if (result.kind !== "reference" || !result.text)
        throw Error(
          result.reason ??
            "Use the agent’s native attachment command for this file.",
        );
      setDeliveries((previous) => ({
        ...previous,
        [attachmentId]: result.text!,
      }));
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="pc-session-attachments">
      <p className="muted">
        Files stay with this conversation. A reference lets the agent read a
        file when you send your next message.
      </p>
      {active && <AttachmentPicker onFiles={uploads.uploadFiles} />}
      <AttachmentTray
        items={uploads.items.map((item) => ({
          ...item,
          removable: item.status === "error",
        }))}
        onRemove={(id) => void uploads.remove(id)}
        onRetry={uploads.retry}
      />
      {active &&
        uploads.items
          .filter((item) => item.status === "ready")
          .map((item) =>
            deliveries[item.id] ? (
              <AttachmentDelivery
                key={item.id}
                name={item.name}
                text={deliveries[item.id]!}
                onCopy={() => {
                  void navigator.clipboard.writeText(deliveries[item.id]!).then(
                    () =>
                      setNotice(
                        "Reference copied. Paste it into the agent’s input when ready.",
                      ),
                    (e) => setError(e),
                  );
                }}
              />
            ) : (
              <Button
                key={item.id}
                size="sm"
                onClick={() => void prepare(item.id)}
              >
                Use {item.name}
              </Button>
            ),
          )}
      <p role="status" aria-live="polite">
        {notice}
      </p>
      <ErrorMessage error={error ?? uploads.error} />
    </div>
  );
}
