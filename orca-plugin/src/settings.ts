export type TransportChoice = "auto" | "http" | "channel" | "bridge";
export interface PluginSettings { autoConsole: boolean; transport: TransportChoice; port: number; pacerHome: string; pollSeconds: number; lastAlertAt: number }
export function readSettings(raw: Record<string, unknown>, home: string): PluginSettings {
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  return {
    autoConsole: typeof raw.autoConsole === "boolean" ? raw.autoConsole : true,
    transport: ["auto", "http", "channel", "bridge"].includes(raw.transport as string) ? raw.transport as TransportChoice : "auto",
    port: finite(raw.port) && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 4317,
    pacerHome: typeof raw.pacerHome === "string" && raw.pacerHome.length > 0 ? raw.pacerHome : `${home}/.pacer`,
    pollSeconds: finite(raw.pollSeconds) ? Math.max(5, Math.min(300, raw.pollSeconds)) : 10,
    lastAlertAt: finite(raw.lastAlertAt) && raw.lastAlertAt >= 0 ? raw.lastAlertAt : 0,
  };
}
