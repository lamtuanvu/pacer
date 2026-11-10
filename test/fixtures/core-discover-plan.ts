// Core entry for front-door and live tests: the local model server probes follow DISCOVER_PLAN, a JSON map from
// base URL to {delayMs, error}, instead of the endpoint plugin. Servers missing from the plan list no models.
// discoverEndpointModels is replaced as Bun loads it, so stdio and HTTP serving (which takes no op deps) both use the plan.
import { plugin } from "bun";

const planned = `
const discoverPlan: Record<string, { delayMs: number; error?: string }> = JSON.parse(process.env.DISCOVER_PLAN ?? "{}");
export async function discoverEndpointModels(_ctx: Ctx, input: { baseUrl: string }) {
  const step = discoverPlan[input.baseUrl];
  if (!step) return { listed: false as const, error: "unreachable", detail: "Endpoint unreachable. Check the URL and try again." };
  await Bun.sleep(step.delayMs);
  if (step.error) throw new Error(step.error);
  return { listed: true as const, models: [{ id: "planned" }] };
}
`;
plugin({ name: "discover-plan", setup(build) {
  build.onLoad({ filter: /[\\/]src[\\/]plugins[\\/]endpoint-adapter\.ts$/ }, async ({ path }) => {
    const source = await Bun.file(path).text(), head = "export async function discoverEndpointModels(";
    if (!source.includes(head)) throw Error("endpoint-adapter.ts no longer exports discoverEndpointModels as expected");
    return { loader: "ts", contents: source.replace(head, "async function pluginDiscoverEndpointModels(") + planned };
  });
} });

const { main } = await import("../../src/cli");
const r = await main(process.argv.slice(2));
if (r.out) process.stdout.write(r.out.endsWith("\n") ? r.out : `${r.out}\n`);
if (r.err) process.stderr.write(r.err.endsWith("\n") ? r.err : `${r.err}\n`);
if (!r.keepAlive) process.exit(r.code);
