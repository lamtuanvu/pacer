export interface SessionDraft {
  request: string;
  repo: string;
  executor: string;
  mode: string;
  base: string;
  checkout: string;
  draftId: string;
}
export const blankSession: SessionDraft = {
  request: "",
  repo: "",
  executor: "",
  mode: "new",
  base: "",
  checkout: "",
  draftId: "",
};
export function sessionCreateParams(
  draft: SessionDraft,
  requestId: string,
  attachments: string[],
) {
  if (!draft.request.trim() || !draft.repo || !draft.executor || !draft.draftId)
    throw Error(
      "Enter a request and choose a repository and available executor.",
    );
  if (draft.mode === "new" && !draft.base) throw Error("Choose a base branch.");
  if (draft.mode === "current" && !draft.checkout)
    throw Error("Choose an existing checkout.");
  return {
    request_id: requestId,
    draftId: draft.draftId,
    request: draft.request,
    repo: draft.repo,
    executor: draft.executor,
    workspace:
      draft.mode === "current"
        ? { mode: "current" as const, path: draft.checkout }
        : { mode: "new" as const, base: draft.base },
    attachments,
  };
}
