import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../config.js";
import type { ToolResult } from "../types.js";
import { errorMessage } from "../lib/http.js";

class ClawPumpMcpClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<Client>;

  private async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    if (!config.clawpump.mcpEnabled) throw new Error("ClawPump MCP is disabled");
    if (!config.clawpump.apiKey) throw new Error("CLAWPUMP_API_KEY is not configured");

    this.connecting = (async () => {
      const executable = path.resolve(process.cwd(), "node_modules", "@clawpump", "agents", "bin", "clawpump-agents.mjs");
      this.transport = new StdioClientTransport({
        command: process.execPath,
        args: [executable],
        env: { ...process.env, CLAWPUMP_API_KEY: config.clawpump.apiKey } as Record<string, string>
      });
      const client = new Client({ name: "terminal-v-solana", version: "0.2.0" });
      await client.connect(this.transport);
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async listTools() {
    const client = await this.connect();
    return client.listTools();
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    try {
      const client = await this.connect();
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 12_000 });
      const structured = "structuredContent" in result ? result.structuredContent : undefined;
      if (structured) return { ok: !result.isError, tool, data: structured };
      const content = Array.isArray(result.content) ? result.content as Array<{ type: string; text?: string }> : [];
      const text = content
        .filter((item) => item.type === "text")
        .map((item) => item.text || "")
        .join("\n");
      let data: unknown = text;
      try { data = text ? JSON.parse(text) : null; } catch { /* text is a valid tool result */ }
      return result.isError
        ? { ok: false, tool, error: typeof data === "string" ? data : JSON.stringify(data) }
        : { ok: true, tool, data };
    } catch (error) {
      return { ok: false, tool, error: errorMessage(error) };
    }
  }

  async close() {
    await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }
}

export const clawpumpMcp = new ClawPumpMcpClient();
