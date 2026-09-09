import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { executionEnabled: true, clawpump: {}, jupiter: { apiUrl: "https://mock.invalid" }, zeroEx: {}, rpc: { primary: "https://mock.invalid" } } }));
vi.mock("../clawpump/mcp.js", () => ({ clawpumpMcp: { call: vi.fn() } }));
vi.mock("../clawpump/market.js", () => ({ getBoard: vi.fn(), getHolders: vi.fn(), getOnchainMarket: vi.fn(), getTrenches: vi.fn(), trenchSorts: [] }));
vi.mock("../market/walletPortfolio.js", () => ({ walletPortfolio: vi.fn(async (walletAddress: string) => ({ walletAddress, assets: [] })) }));
vi.mock("../lib/http.js", () => ({ errorMessage: String, fetchJson: vi.fn(async () => ({ swapTransaction: "unsigned" })) }));

import { onchainRouter, quoteSchema, sameQuoteRequest } from "./onchain";
import { clawpumpMcp } from "../clawpump/mcp";
import { fetchJson } from "../lib/http";

let server: Server;
let base: string;
const order = { chain: "solana" as const, router: "clawpump" as const, inputMint: "So11111111111111111111111111111111111111112", outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1000000000", slippageBps: 50, walletAddress: "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump" };
const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(onchainRouter);
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server?.close());

describe("trade quote validation", () => {
  it("accepts Jupiter on Solana and 0x on Robinhood", () => {
    expect(quoteSchema.parse({ ...order, router: "jupiter" })).toMatchObject({ chain: "solana", router: "jupiter" });
    expect(quoteSchema.parse({
      chain: "robinhood", router: "0x", inputMint: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      outputMint: "0x1111111111111111111111111111111111111111", amount: "1", slippageBps: 50,
      walletAddress: "0x2222222222222222222222222222222222222222"
    })).toMatchObject({ chain: "robinhood", router: "0x" });
  });

  it("rejects cross-chain addresses and unsupported Robinhood routers", () => {
    expect(() => quoteSchema.parse({ ...order, inputMint: "0x1111111111111111111111111111111111111111" })).toThrow();
    expect(() => quoteSchema.parse({ ...order, chain: "robinhood", router: "jupiter" })).toThrow();
  });

  it("binds transaction creation to every quoted field", () => {
    const parsed = quoteSchema.parse(order);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...order }))).toBe(true);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...order, amount: "1000000001" }))).toBe(false);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...order, slippageBps: 51 }))).toBe(false);
  });
});

it("binds an executable quote to every order field and consumes it once", async () => {
  vi.mocked(clawpumpMcp.call).mockResolvedValue({ ok: true, tool: "swap_quote", data: { ...order, inAmount: order.amount, routePlan: [] } });
  const quote = await (await post("/quote", order)).json() as { quoteId: string };
  for (const change of [{ amount: "999" }, { inputMint: order.outputMint }, { outputMint: order.inputMint }, { slippageBps: 500 }, { walletAddress: "11111111111111111111111111111111" }, { router: "jupiter" }]) {
    expect((await post("/transaction", { ...order, ...change, quoteId: quote.quoteId })).status).toBe(409);
  }
  expect(fetchJson).not.toHaveBeenCalled();
  expect((await post("/transaction", { ...order, quoteId: quote.quoteId })).status).toBe(200);
  expect(fetchJson).toHaveBeenCalledTimes(1);
  expect((await post("/transaction", { ...order, quoteId: quote.quoteId })).status).toBe(409);
});

it("rejects an upstream quote for a different amount", async () => {
  vi.mocked(clawpumpMcp.call).mockResolvedValue({ ok: true, tool: "swap_quote", data: { ...order, inAmount: "999", routePlan: [] } });
  expect((await post("/quote", order)).status).toBe(502);
});

it("portfolio does not call the private agent tool", async () => {
  vi.mocked(clawpumpMcp.call).mockClear();
  expect(await (await fetch(base + "/portfolio/" + order.walletAddress)).json()).toMatchObject({ walletAddress: order.walletAddress });
  expect(clawpumpMcp.call).not.toHaveBeenCalled();
});
