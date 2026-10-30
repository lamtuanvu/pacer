export interface DiscoveredModel { id: string; name?: string; context?: number; output?: number; tools?: boolean }
export type DiscoveryResult = {listed: true; models: DiscoveredModel[]} | {listed: false; error: string; detail: string};
