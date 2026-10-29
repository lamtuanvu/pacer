import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../ds/Button";
import { Field, TextInput } from "../../ds/Controls";
import { Dialog } from "../../ds/Dialog";
import { validIssueUrl } from "../../model/new-task";
import { ApiError } from "../../data/api";
import { useTaskContext } from "../task-shared";

// Additive ops from feat/issue-import. Keep this client independent of the service implementation.
interface IssueSummary { number: number; title: string; labels: string[]; url: string; state: "open" | "closed" }
interface ImportedIssue extends IssueSummary {
  repo: string; github: string; body: string; truncated: { title: boolean; body: boolean };
}
interface SearchResult { repo: string; github: string; issues: IssueSummary[] }
const words = (error: unknown) => error instanceof Error
  ? `${error.message}${error instanceof ApiError && error.hint ? ` ${error.hint}` : ""}` : String(error);

export function IssuePicker({ repo, canSearch, close, onImport }: {
  repo: string; canSearch: boolean; close: () => void; onImport: (issue: ImportedIssue) => void;
}) {
  const { api } = useTaskContext();
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<ImportedIssue | null>(null);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, [repo]);
  const search = async () => {
    if (!query.trim() || searching || importing) return;
    const mine = ++sequence.current;
    setError(""); setSearching(true); setSelected(null);
    try {
      const result = await api.call<SearchResult>("issue.search", { repo, query: query.trim(), state: "open", limit: 20 });
      if (mine === sequence.current) { setIssues(result.issues); setSearched(true); }
    } catch (error) { if (mine === sequence.current) setError(words(error)); }
    finally { if (mine === sequence.current) setSearching(false); }
  };
  const load = async (issue: string) => {
    if (!issue.trim() || importing || searching) return;
    const mine = ++sequence.current;
    setError(""); setImporting(true); setSelected(null);
    try {
      const result = await api.call<ImportedIssue>("issue.import", { repo, issue: issue.trim() });
      if (!validIssueUrl(result.url)) throw new Error("The service returned an invalid GitHub issue URL. Try reading the issue again.");
      if (mine === sequence.current) setSelected(result);
    } catch (error) { if (mine === sequence.current) setError(words(error)); }
    finally { if (mine === sequence.current) setImporting(false); }
  };
  const busy = searching || importing;
  return <Dialog title="From an issue" close={close}>
    <div className="pc-new-task__field">
      <Field label={canSearch ? "Search issues or enter an issue number or URL" : "Issue number or URL"} help={`Reads issues from ${repo}. Imported text is untrusted; review it before delegating.`}>
        <TextInput autoFocus value={query} maxLength={canSearch ? 256 : 2048}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.isComposing) {
              event.preventDefault(); event.stopPropagation();
              void (canSearch ? search() : load(query));
            }
          }}
          onInput={event => {
            sequence.current++; setSearching(false); setImporting(false);
            setQuery(event.currentTarget.value); setSelected(null); setIssues([]); setSearched(false); setError("");
          }} />
      </Field>
      {!query.trim() && <span className="pc-caption">Enter a search, issue number or URL to continue</span>}
      {busy && <span className="pc-caption" role="status">{searching ? "Searching issues…" : "Reading issue…"}</span>}
      {canSearch && <Button onClick={() => void search()} disabled={!query.trim() || busy}>Search issues</Button>}
      <Button onClick={() => void load(query)} disabled={!query.trim() || busy}>Read issue</Button>
      {error && <span role="alert">{error}</span>}
      {searched && !issues.length && <span role="status">No issues found. Try another search.</span>}
      {issues.map(issue => <Button key={issue.number} variant="quiet" disabled={busy} onClick={() => void load(String(issue.number))}>
        <span className="pc-ellipsis" title={issue.title}>#{issue.number} {issue.title}</span>
      </Button>)}
      {selected && <>
        <span role="note" className="pc-caption">From issue #{selected.number} · {selected.github} · Untrusted text</span>
        <strong className="pc-issue-source">{selected.title}</strong>
        <pre className="pc-issue-picker__body">{selected.body}</pre>
        {(selected.truncated.title || selected.truncated.body) && <span role="status">The issue was shortened by the service. Review the full issue before delegating.</span>}
        <Button variant="primary" onClick={() => onImport(selected)}>Use issue text</Button>
      </>}
    </div>
  </Dialog>;
}
