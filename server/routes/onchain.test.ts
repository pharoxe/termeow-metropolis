import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { executionEnabled: true, kuru: { apiUrl: "https://mock.invalid" }, zeroEx: { apiKey: "test", apiUrl: "https://mock.invalid" }, network: { chainId: 143 }, rpc: { primary: "https://mock.invalid" } } }));
vi.mock("../agent/monadTools.js", () => ({ runResearchTool: vi.fn() }));
vi.mock("../sources/nansen.js", () => ({ getNansen: vi.fn() }));
vi.mock("../sources/perpl.js", () => ({ getPerpl: vi.fn() }));
vi.mock("../market/monadWalletPortfolio.js", () => ({ monadWalletPortfolio: vi.fn(async (walletAddress: string) => ({ walletAddress, assets: [] })) }));
vi.mock("../lib/http.js", () => ({ errorMessage: String, fetchJson: vi.fn(async () => ({ buyAmount: "5", transaction: { to: "0x3333333333333333333333333333333333333333", data: "0x" } })) }));

import { onchainRouter, quoteSchema, sameQuoteRequest } from "./onchain";
import { fetchJson } from "../lib/http";

let server: Server;
let base: string;
const order = {
  chain: "monad" as const, router: "0x" as const,
  inputMint: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", outputMint: "0x1111111111111111111111111111111111111111",
  amount: "1000000000", slippageBps: 50, walletAddress: "0x2222222222222222222222222222222222222222"
};
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
  it("accepts Kuru and 0x on Monad", () => {
    expect(quoteSchema.parse({ ...order, router: "kuru" })).toMatchObject({ chain: "monad", router: "kuru" });
    expect(quoteSchema.parse(order)).toMatchObject({ chain: "monad", router: "0x" });
  });

  it("rejects non-EVM addresses and unsupported routers", () => {
    expect(() => quoteSchema.parse({ ...order, inputMint: "So11111111111111111111111111111111111111112" })).toThrow();
    expect(() => quoteSchema.parse({ ...order, router: "jupiter" })).toThrow();
    expect(() => quoteSchema.parse({ ...order, outputMint: order.inputMint })).toThrow();
  });

  it("binds transaction creation to every quoted field", () => {
    const parsed = quoteSchema.parse(order);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...order }))).toBe(true);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...order, amount: "1000000001" }))).toBe(false);
    expect(sameQuoteRequest(parsed, quoteSchema.parse({ ...order, slippageBps: 51 }))).toBe(false);
  });
});

it("binds an executable quote to every order field and consumes it once", async () => {
  const quote = await (await post("/quote", order)).json() as { quoteId: string };
  expect(fetchJson).toHaveBeenCalledTimes(1);
  for (const change of [{ amount: "999" }, { outputMint: "0x4444444444444444444444444444444444444444" }, { slippageBps: 500 }, { walletAddress: "0x5555555555555555555555555555555555555555" }, { router: "kuru" }]) {
    expect((await post("/transaction", { ...order, ...change, quoteId: quote.quoteId })).status).toBe(409);
  }
  expect((await post("/transaction", { ...order, quoteId: quote.quoteId })).status).toBe(200);
  expect((await post("/transaction", { ...order, quoteId: quote.quoteId })).status).toBe(409);
});

it("serves a wallet portfolio for an EVM address", async () => {
  expect(await (await fetch(base + "/portfolio/" + order.walletAddress)).json()).toMatchObject({ walletAddress: order.walletAddress });
});
