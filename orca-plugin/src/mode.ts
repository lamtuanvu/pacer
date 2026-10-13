import { join } from "node:path";
export type PluginMode = "live" | "bootstrap";
/** Only pacer plugin install opts a folder into mutable live panels. */
export function pluginMode(pluginRoot: string, fs: { exists(path: string): boolean }): PluginMode {
 return fs.exists(join(pluginRoot, ".pacer-managed")) ? "live" : "bootstrap";
}
