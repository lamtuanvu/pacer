import { useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentItem } from "../ds/AttachmentTray";
import type { BrowserApi } from "../data/api";
interface Upload extends AttachmentItem {
  file?: File;
  mime?: string;
}
async function response<T>(result: Response): Promise<T> {
  const data = await result.json();
  if (!result.ok)
    throw Error(data.error?.message ?? "Attachment request failed");
  return data as T;
}
export function filesFromPaste(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}
export function insertPastedText(
  value: string,
  text: string,
  start: number,
  end: number,
): string {
  return text ? value.slice(0, start) + text + value.slice(end) : value;
}
export function useAttachments(
  api: BrowserApi,
  draftId: string,
  onDraft: (id: string) => void,
  limit?: { bytes: number; label: string },
) {
  const [items, setItems] = useState<Upload[]>([]),
    [error, setError] = useState("");
  const pendingDraft = useRef<Promise<string>>(),
    previews = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );
  useEffect(() => {
    if (!draftId) return;
    let active = true;
    void fetch(`/v3/attachments?draft=${encodeURIComponent(draftId)}`, {
      credentials: "same-origin",
    })
      .then((r) =>
        response<{ id: string; name: string; size: number; mime: string }[]>(r),
      )
      .then((rows) => {
        if (active)
          setItems((previous) => [
            ...rows.map((row) => ({ ...row, status: "ready" as const })),
            ...previous.filter((item) => item.status !== "ready"),
          ]);
      })
      .catch((e) => {
        if (active) setError(String(e.message ?? e));
      });
    return () => {
      active = false;
    };
  }, [draftId]);
  const ensureDraft = async () => {
    if (draftId) return draftId;
    if (!pendingDraft.current)
      pendingDraft.current = api
        .call<{ id: string }>("session.draft.create", {})
        .then((value) => {
          onDraft(value.id);
          return value.id;
        })
        .finally(() => {
          pendingDraft.current = undefined;
        });
    return pendingDraft.current;
  };
  const upload = async (
    file: File,
    batch: string,
    temporaryId: string = crypto.randomUUID(),
  ) => {
    let preview: string | undefined;
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      preview = URL.createObjectURL(file);
      previews.current.add(preview);
    }
    setItems((previous) => [
      ...previous.filter((item) => item.id !== temporaryId),
      {
        id: temporaryId,
        name: file.name,
        size: file.size,
        status: "uploading",
        file,
        preview,
      },
    ]);
    try {
      if (limit && file.size > limit.bytes) throw new Error(`Attachment exceeds ${limit.label}`);
      const draft = await ensureDraft();
      const value = await response<{
        id: string;
        name: string;
        size: number;
        mime: string;
      }>(
        await fetch(
          `/v3/attachments?draft=${encodeURIComponent(draft)}&batch=${encodeURIComponent(batch)}`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "X-Pacer-Client": "app",
              "X-Pacer-Filename": encodeURIComponent(file.name),
              "Content-Type": file.type || "application/octet-stream",
            },
            body: file,
          },
        ),
      );
      setItems((previous) =>
        previous.map((item) =>
          item.id === temporaryId
            ? { ...value, status: "ready", preview }
            : item,
        ),
      );
    } catch (e) {
      setItems((previous) =>
        previous.map((item) =>
          item.id === temporaryId
            ? {
                ...item,
                status: "error",
                error: e instanceof Error ? e.message : String(e),
              }
            : item,
        ),
      );
    }
  };
  return {
    items,
    error,
    ensureDraft,
    uploadFiles: (files: File[]) => {
      const batch = crypto.randomUUID();
      if (files.length > 20) {
        setError("Choose at most 20 files at once.");
        return;
      }
      for (const file of files) void upload(file, batch);
    },
    retry: (id: string) => {
      const item = items.find((item) => item.id === id);
      if (item?.file) void upload(item.file, crypto.randomUUID(), id);
    },
    remove: async (id: string) => {
      try {
        const item = items.find((item) => item.id === id);
        if (item?.status === "ready") {
          const result = await fetch(
            `/v3/attachments/${encodeURIComponent(id)}?draft=${encodeURIComponent(draftId)}`,
            {
              method: "DELETE",
              credentials: "same-origin",
              headers: { "X-Pacer-Client": "app" },
            },
          );
          if (!result.ok) await response(result);
        }
        setItems((previous) => previous.filter((item) => item.id !== id));
      } catch (e) {
        setError(String(e));
      }
    },
  };
}
