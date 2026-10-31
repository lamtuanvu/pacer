import { useEffect, useState } from "preact/hooks";
import { useTaskContext } from "../task-shared";
interface Chunk { stdout: string; stderr: string; next?: { stdout: number; stderr: number }; source?: string }
/** Follow byte offsets to the final chunk; only retain the last lines for the question context. */
export function useOutputTail(id: string, revision: unknown = "") {
  const { api } = useTaskContext();
  const [result, setResult] = useState<{ loading: boolean; text?: string; error?: unknown }>({ loading: true });
  useEffect(() => {
    let active = true;
    setResult({ loading: true });
    void (async () => {
      let offsets = { stdout: 0, stderr: 0 }, text = "", source: string | undefined;
      while (active) {
        const chunk = await api.call<Chunk>("task.log", { id, ...offsets });
        if (source && chunk.source !== source) { offsets = { stdout: 0, stderr: 0 }; text = ""; source = chunk.source; continue; }
        source = chunk.source;
        text = [text, chunk.stdout, chunk.stderr].filter(Boolean).join("\n").trim().split("\n").slice(-6).join("\n");
        if (!chunk.next || (chunk.next.stdout - offsets.stdout < 256 * 1024 && chunk.next.stderr - offsets.stderr < 256 * 1024)) break;
        offsets = chunk.next;
      }
      if (active) setResult({ loading: false, text });
    })().catch(error => { if (active) setResult({ loading: false, error }); });
    return () => { active = false; };
  }, [api, id, revision]);
  return result;
}
