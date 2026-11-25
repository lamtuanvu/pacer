//! The TS source `opencode-report.ts` emits as a byte-equal string for
//! OpenCode's native plugin runtime (M3 C3). The template is held in three
//! `concat!` segments (`SEG1`/`SEG2`/`SEG3`); the only interpolations are
//! `serde_json::to_string(session_id)` and `serde_json::to_string(run_dir)`,
//! exactly as `JSON.stringify` does in the reference. The generated file's
//! `join("\\n")` line stays the two characters `\n`.
//!
//! The golden (`tests/fixtures/opencode-report.golden.txt`) is produced by:
//! `bun -e 'import {opencodeReportingSource} from "./plugins/agent-session/opencode-report"; process.stdout.write(opencodeReportingSource("ses_\"q\n", "/tmp/run dir"))'`

const SEG1: &str = concat!(
    "import { Plugin } from \"@opencode/plugin\";\n",
    "import { writeFileSync, renameSync } from \"node:fs\";\n",
    "import { join } from \"node:path\";\n",
    "import { randomUUID } from \"node:crypto\";\n",
    "const sessionID = ",
);

const SEG2: &str = ";\nconst dir = ";

const SEG3: &str = concat!(
    ";\n",
    "const atomic = (name, text) => {\n",
    "  const temp = join(dir, name + \".\" + randomUUID() + \".tmp\");\n",
    "  writeFileSync(temp, text, {mode: 0o600, flag: \"wx\"});\n",
    "  renameSync(temp, join(dir, name));\n",
    "};\n",
    "export default Plugin.define({\n",
    "  id: \"pacer-session-report\",\n",
    "  setup(ctx) {\n",
    "    const controller = new AbortController();\n",
    "    const status = (value, summary) => atomic(\"session-status.json\", JSON.stringify({status: value, summary, at: Date.now() / 1000}));\n",
    "    status(\"turn-ended\", \"Agent is ready for input\");\n",
    "    void (async () => {\n",
    "      for await (const event of ctx.event.subscribe({signal: controller.signal})) {\n",
    "        const data = event.data;\n",
    "        if (!data || (data.sessionID ?? data.request?.sessionID ?? data.form?.sessionID) !== sessionID) continue;\n",
    "        if ([\"session.execution.started\", \"permission.replied\", \"form.replied\"].includes(event.type)) status(\"running\", \"Agent is working\");\n",
    "        else if ([\"permission.asked\", \"form.created\"].includes(event.type)) status(\"needs-input\", \"Agent is waiting for input\");\n",
    "        else if ([\"session.execution.succeeded\", \"session.execution.failed\", \"session.execution.interrupted\"].includes(event.type)) {\n",
    "          status(\"turn-ended\", event.type === \"session.execution.failed\" ? \"Agent turn failed; inspect the terminal\" : \"Agent finished its turn\");\n",
    "          try {\n",
    "            const messages = await ctx.session.context({sessionID});\n",
    "            const assistant = [...messages].reverse().find(message => message.type === \"assistant\");\n",
    "            const text = assistant?.content?.filter(part => part.type === \"text\" && typeof part.text === \"string\").map(part => part.text).join(\"\\n\");\n",
    "            if (text) atomic(\"transcript-report.md\", text.slice(-16000));\n",
    "          } catch { /* Native terminal retains output when transcript access fails. */ }\n",
    "        }\n",
    "      }\n",
    "    })().catch(() => {\n",
    "      if (!controller.signal.aborted) {\n",
    "        try { status(\"needs-input\", \"OpenCode activity reporting disconnected; inspect the native terminal.\"); } catch {}\n",
    "      }\n",
    "    });\n",
    "    return () => controller.abort();\n",
    "  },\n",
    "});\n",
);

/// Loaded by OpenCode's native plugin runtime, scoped to one Pacer
/// conversation (`index.ts:2-45`). Byte-equal to `opencodeReportingSource`.
pub fn opencode_reporting_source(session_id: &str, run_dir: &str) -> String {
    // `serde_json::to_string` always succeeds for `&str`, so `unwrap_or_default`
    // returns the exact JSON-escaped value (never the fallback).
    let mut source = String::with_capacity(SEG1.len() + SEG2.len() + SEG3.len() + 64);
    source.push_str(SEG1);
    let session = serde_json::to_string(session_id).unwrap_or_default();
    source.push_str(&session);
    source.push_str(SEG2);
    let dir = serde_json::to_string(run_dir).unwrap_or_default();
    source.push_str(&dir);
    source.push_str(SEG3);
    source
}
