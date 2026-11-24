# Question tool

Ask and answer through pacer's structured question ops — never free-form "please reply" in chat as a substitute for a blocking decision.

```
pacer ask --type <kind> [--option ...] [--recommend] [--blocks] [--artifact] --step <id> [--attempt <n>] "<text>"
pacer answer q_<id> "<answer>" [--note <text>] [--expect-rev <n>]
```

- `kind`: `yes_no` | `approve_revise` | `single` | `text`
- Use `--blocks` when the step must wait on the answer.
- Use `--recommend` when you have a preferred choice for an `auto` step (never for `must` / publish).
- Escalate with `pacer question escalate <id> --suggested <text> --reason <text>` when the person must decide.
