# Open PR / publish

Publishing was approved by the person on a `must` step. Publish this run through the engine CLI (which reads `expect_rev` for you):

```
pacer run publish <runId> --title "<short PR title>" --body-file <path-to-body.md> [--draft]
```

- `<runId>` is this run's id from the step instruction line (`This step is open_pr of run <id>`) or from `PACER_RUN_ID` / your run grant environment.
- Write the PR body (including the live-validation / evidence summary when available) to a temp file and pass it as `--body-file` (max 60 KiB).
- Pass `--draft` when opening a draft PR; omit it for a ready-for-review PR.
- Do not push outside this publishing gate.

On failure (conflict, not allowed, missing opt-in, body too large): do not invent a PR URL. Finish with `pacer step result` describing the error and stop.

On success: finish with `pacer step result` including the PR URL or local remote ref from the command output.
