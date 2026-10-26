/** Permission decisions use plain language; wire IDs remain in technical details. */
const capabilityNames: Record<string, string> = {
  "tasks.read": "Read task details", "events.subscribe": "Follow task updates",
  "process.spawn": "Run permitted programs", "fs.read": "Read permitted files",
  "fs.write": "Change permitted files", "net.http": "Contact permitted websites",
  "secrets.resolve": "Use approved credentials", "config.get": "Read this plugin's pacer settings",
  "entitlement.report": "Report license status", "log": "Write plugin diagnostics",
  "usage.state": "Store usage observations", hosts: "Use configured remote hosts",
};
const contributionNames: Record<string, string> = {
  diagnostic: "Health checks", agentSession: "Agent sessions", observation: "Task observation",
  decision: "Routing decisions", usage: "Usage readings", classifier: "Task classification",
  notifier: "Notifications", endpoint: "API endpoints", planner: "Planning",
  policy: "Task policy", hostRunner: "Remote execution", remoteCaller: "Remote calls",
  executor: "Execution", surface: "A plugin panel",
};
export interface PluginCapability { name: string; scopes?: string[] }
export function capabilityCopy(capability: PluginCapability): string {
  const label = capabilityNames[capability.name] ?? "Use an additional plugin permission";
  if (!capability.scopes?.length) return label;
  const scope = capability.scopes.includes("*") ? (capability.name === "net.http" ? "any website" : capability.name === "process.spawn" ? "any program" : "any location") :
    `${capability.scopes.length} declared ${capability.name === "net.http" ? "website" : capability.name === "process.spawn" ? "program" : "location"}${capability.scopes.length === 1 ? "" : "s"}`;
  return `${label} (${scope}; see technical details)`;
}
export const contributionCopy = (name: string): string => contributionNames[name] ?? "Other integration";
