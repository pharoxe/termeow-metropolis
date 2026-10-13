export type MonadAgentToolDefinition = {
  name: string;
  upstream: string;
  description: string;
  parameters: { type: "object"; description: string; properties: Record<string, unknown>; required: string[] };
};
export declare const monadAgentTools: MonadAgentToolDefinition[];
