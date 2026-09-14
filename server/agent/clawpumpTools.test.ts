import { describe, expect, it, vi } from "vitest";
vi.mock("../clawpump/mcp.js", () => ({ clawpumpMcp: { call: vi.fn() } }));
import { parseClawpumpTool } from "./clawpumpTools.js";
describe("voice ClawPump tools", () => {
  it("blocks execution, operator-wallet reads and caller-supplied agent IDs", () => {
    for (const name of ["swap_execute", "get_wallet_summaries", "get_wallet_history", "create_agent_run", "__proto__"]) expect(() => parseClawpumpTool(name, {})).toThrow();
    expect(() => parseClawpumpTool("clawpump_token_search", { query: "ANSEM", agent_id: "other" })).toThrow();
  });
  it("keeps requests bounded and rejects invalid mint addresses", () => {
    expect(() => parseClawpumpTool("clawpump_intelligence_market", { token: "ANSEM" })).toThrow();
    expect(() => parseClawpumpTool("clawpump_get_news_feed", { limit: 100 })).toThrow();
    expect(parseClawpumpTool("clawpump_get_news_feed", {})).toEqual({ upstream: "get_news_feed", args: { category: "crypto", limit: 5 } });
  });
});
