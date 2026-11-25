/** Host-projected managed account metadata; credentials never enter this module. */
export interface EndpointModel {
  id: string;
  name?: string;
  context: number;
  output: number;
  tools: boolean;
}
export interface EndpointAccount {
  name: string;
  baseUrl: string;
  keyRef: string | null;
  models: readonly EndpointModel[];
}
export interface OpencodeProvider {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey?: string };
  models: Record<string, { name: string; limit: { context: number; output: number }; tool_call: boolean }>;
}
export function endpointKeyEnv(name: string): string {
  return `PACER_KEY_${name.toUpperCase().replaceAll("-", "_")}`;
}

/** Render all managed connections supplied by the host; no filesystem effects. */
export function renderOpencodeConfig(accounts: readonly EndpointAccount[]): {
  $schema: string;
  provider: Record<string, OpencodeProvider>;
} {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: Object.fromEntries(accounts.map(account => [
      `pacer-${account.name}`,
      {
        npm: "@ai-sdk/openai-compatible",
        name: `${account.name} (pacer)`,
        options: {
          baseURL: account.baseUrl,
          ...(account.keyRef === null ? {} : { apiKey: `{env:${endpointKeyEnv(account.name)}}` }),
        },
        models: Object.fromEntries(account.models.map(model => [model.id, {
          name: model.name ?? model.id,
          limit: { context: model.context, output: model.output },
          tool_call: model.tools,
        }])),
      },
    ])),
  };
}
