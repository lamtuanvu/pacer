/** Loaded by OpenCode's native plugin runtime, scoped to one Pacer conversation. */
export function opencodeReportingSource(sessionId: string, runDir: string): string {
  return `import { Plugin } from "@opencode/plugin";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const sessionID = ${JSON.stringify(sessionId)};
const dir = ${JSON.stringify(runDir)};
const atomic = (name, text) => {
  const temp = join(dir, name + "." + randomUUID() + ".tmp");
  writeFileSync(temp, text, {mode: 0o600, flag: "wx"});
  renameSync(temp, join(dir, name));
};
export default Plugin.define({
  id: "pacer-session-report",
  setup(ctx) {
    const controller = new AbortController();
    const status = (value, summary) => atomic("session-status.json", JSON.stringify({status: value, summary, at: Date.now() / 1000}));
    status("turn-ended", "Agent is ready for input");
    void (async () => {
      for await (const event of ctx.event.subscribe({signal: controller.signal})) {
        const data = event.data;
        if (!data || (data.sessionID ?? data.request?.sessionID ?? data.form?.sessionID) !== sessionID) continue;
        if (["session.execution.started", "permission.replied", "form.replied"].includes(event.type)) status("running", "Agent is working");
        else if (["permission.asked", "form.created"].includes(event.type)) status("needs-input", "Agent is waiting for input");
        else if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) {
          status("turn-ended", event.type === "session.execution.failed" ? "Agent turn failed; inspect the terminal" : "Agent finished its turn");
          try {
            const messages = await ctx.session.context({sessionID});
            const assistant = [...messages].reverse().find(message => message.type === "assistant");
            const text = assistant?.content?.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\\n");
            if (text) atomic("transcript-report.md", text.slice(-16000));
          } catch { /* Native terminal retains output when transcript access fails. */ }
        }
      }
    })().catch(() => {
      if (!controller.signal.aborted) {
        try { status("needs-input", "OpenCode activity reporting disconnected; inspect the native terminal."); } catch {}
      }
    });
    return () => controller.abort();
  },
});
`;
}
