/** Small pieces shared by the run view boards: styles, step state, question card, artifact link/panel. */
import { useEffect, useState } from "preact/hooks";
import runStyles from "./run-view.css" with { type: "text" };
import { Alert } from "../../ds/Alert";
import { Button } from "../../ds/Button";
import { Pill } from "../../ds/Pill";
import { QuestionForm, type QuestionFormQuestion } from "../../ds/QuestionForm";
import { useActions } from "../../data/action-context";
import type { BrowserApi } from "../../data/api";
import type { RunQuestionView } from "../../data/runs";
import { runStatus, stepMarkerGlyph, RUN_ARTIFACT_ERROR, type StepMarker } from "../../../../src/view-model/runs";
import type { ArtifactMeta } from "../../../../src/view-model/run-board";

const styled = new WeakSet<Document>();
/** Adopt the run view stylesheet once per document. A missing CSSStyleSheet (bare test DOM) is not an error. */
export function useRunViewStyles() {
  useEffect(() => {
    if (styled.has(document)) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(runStyles);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch { /* styles are progressive here: content and labels stay readable */ }
    styled.add(document);
  }, []);
}

/** One status chip: a glyph and a word, never colour alone (UI-2, UI-10). */
export function StepState({ marker, status, waitsOnYou, awaitsReview }: { marker: StepMarker; status: string; waitsOnYou?: boolean; awaitsReview?: boolean }) {
  if (waitsOnYou) return <Pill tone="warn"><span aria-hidden="true">{stepMarkerGlyph("waits_you")} </span>Waits on you</Pill>;
  if (awaitsReview) return <Pill tone="info"><span aria-hidden="true">{stepMarkerGlyph(marker)} </span>Waiting for review</Pill>;
  if (status === "pending") return <Pill tone="neutral"><span aria-hidden="true">{stepMarkerGlyph("unknown")} </span>Not started</Pill>;
  const s = runStatus(status);
  return <Pill tone={s.tone}><span aria-hidden="true">{stepMarkerGlyph(marker)} </span>{s.label}</Pill>;
}

export function artifactUrl(runId: string, artId: string): string {
  return `/v3/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artId)}`;
}

/** Artifact links open the stored file in a new tab; the label is the step's own label (UI-12). */
export function ArtifactLink({ runId, artifact }: { runId: string; artifact: Pick<ArtifactMeta, "id" | "label"> }) {
  return <a className="pc-inline-link" href={artifactUrl(runId, artifact.id)} target="_blank" rel="noopener noreferrer">{artifact.label}</a>;
}

export type FetchText = (url: string) => Promise<string>;
export const defaultFetchText: FetchText = async url => {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`The file could not be read (${res.status}).`);
  return res.text();
};
const TEXT_MIME = /^(text\/|application\/(json|x-yaml|yaml))/i;
const INLINE_MAX = 256 * 1024;

/** The forming spec (or any text artifact) shown as text; other types fall back to the link. */
export function ArtifactText({ runId, artifact, revision, fetchText = defaultFetchText }: { runId: string; artifact: ArtifactMeta; fetchText?: FetchText; revision?: number }) {
  const [state, setState] = useState<{ id?: string; text?: string; error?: boolean }>({});
  const inline = TEXT_MIME.test(artifact.mime) && artifact.size <= INLINE_MAX;
  useEffect(() => {
    if (!inline) return;
    let active = true;
    // Keep the text on screen while a newer copy is read (no flicker); a different file starts empty.
    setState(prev => prev.id === artifact.id ? prev : { id: artifact.id });
    fetchText(artifactUrl(runId, artifact.id)).then(
      text => { if (active) setState({ id: artifact.id, text }); },
      (e: unknown) => {
        console.warn("runs: artifact read failed", e);
        if (active) setState({ id: artifact.id, error: true });
      },
    );
    return () => { active = false; };
  }, [runId, artifact.id, artifact.size, revision, inline]);
  if (!inline) return <p className="rv-cap">This file is not shown here. <ArtifactLink runId={runId} artifact={artifact} /></p>;
  if (state.error) return <Alert tone="error" title="Couldn't open the file"><p>{RUN_ARTIFACT_ERROR}</p></Alert>;
  if (state.text === undefined || state.id !== artifact.id) return <p className="rv-cap" role="status">Loading {artifact.label}…</p>;
  return <pre className="rv-spec" tabIndex={0} aria-label={artifact.label}>{state.text}</pre>;
}

/** One question, drawn by the shared form (queue, run view and Live board look the same). */
export function RunQuestionCard({ question, canAnswer, api, onAnswered, onConflict, artifactLabel }: {
  question: RunQuestionView;
  canAnswer: boolean;
  api: BrowserApi;
  onAnswered: () => void;
  onConflict: () => void;
  artifactLabel?: string;
}) {
  const runner = useActions();
  const form: QuestionFormQuestion = {
    id: question.id, runId: question.runId, text: question.text, answerType: question.answerType, rev: question.rev,
    ...(question.options ? { options: question.options } : {}),
    ...(question.recommended ? { recommended: question.recommended } : {}),
    ...(question.artifact ? { artifact: { id: question.artifact.id, label: question.artifact.label ?? artifactLabel } } : {}),
    ...(question.suggestedAnswer ? { suggestedAnswer: question.suggestedAnswer } : {}),
  };
  const submit = async (input: { answer: string; note?: string; expect_rev: number }) => {
    const call = runner ? <T,>(op: string, params?: unknown) => runner.call<T>(op, params) : api.call.bind(api);
    await call("question.answer", {
      id: question.id, answer: input.answer, expect_rev: input.expect_rev,
      ...(input.note !== undefined && input.note !== "" ? { note: input.note } : {}),
    });
    onAnswered();
  };
  return (
    <div className="rv-box rv-box--form">
      <QuestionForm key={`${question.id}:${question.rev}`} question={form} canAnswer={canAnswer} onSubmit={submit} onConflict={onConflict} />
    </div>
  );
}

export function BoardButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: preact.ComponentChildren }) {
  return <Button size="sm" variant={active ? "secondary" : "quiet"} aria-pressed={active} onClick={onClick}>{children}</Button>;
}
