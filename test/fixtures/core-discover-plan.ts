// Core entry for front-door tests: the local model server probes follow DISCOVER_PLAN, a JSON map from
// base URL to {delayMs, error}, instead of the endpoint plugin. Servers missing from the plan list no models.
import { cliDeps, main } from "../../src/cli";

const plan: Record<string, { delayMs: number; error?: string }> = JSON.parse(process.env.DISCOVER_PLAN ?? "{}");
Object.assign(cliDeps, { endpoint: { discover: async (_ctx: unknown, { baseUrl }: { baseUrl: string }) => {
  const step = plan[baseUrl];
  if (!step) return { listed: false, error: "unreachable", detail: "Endpoint unreachable. Check the URL and try again." };
  await Bun.sleep(step.delayMs);
  if (step.error) throw new Error(step.error);
  return { listed: true, models: [{ id: "planned" }] };
} } });

const r = await main(process.argv.slice(2));
if (r.out) process.stdout.write(r.out.endsWith("\n") ? r.out : `${r.out}\n`);
if (r.err) process.stderr.write(r.err.endsWith("\n") ? r.err : `${r.err}\n`);
if (!r.keepAlive) process.exit(r.code);
