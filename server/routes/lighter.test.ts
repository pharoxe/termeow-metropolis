import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LighterMarket, LighterTrade } from "../../shared/wire.js";
import { TAKER_SIDE_LABEL, type BookResult, type FlowResult, type FundingResult, type MarketsResult, type TradesResult } from "../lighter/service.js";
import { LIGHTER_FLOW_SOURCE, buildLighterFlow, createLighterRouter, type LighterServiceLike } from "./lighter.js";

const NOW = 1_788_698_190_000;
const MARKET: LighterMarket = { marketId: 0, symbol: "ETH", status: "active", markPrice: 2503, indexPrice: 2502.5, lastPrice: 2503.1, change24Pct: 1.2, volume24Usd: 1_000_000, trades24: 4200, sizeDecimals: 4, priceDecimals: 2 };
const TRADE: LighterTrade = { id: "1", tx: "0xabc", time: NOW - 1000, price: 2503.1, size: 0.1, usd: 250.31, takerSide: "buy", liquidation: false };

function fakeService(overrides: Partial<Record<keyof LighterServiceLike, unknown>> = {}) {
  const markets = vi.fn(async (): Promise<MarketsResult> => ({ markets: [MARKET], observedAt: NOW, stale: false }));
  const book = vi.fn(async (marketId: number): Promise<BookResult> => ({
    marketId, asks: [{ price: 2503.2, size: 1 }], bids: [{ price: 2503, size: 2 }], mid: 2503.1, spreadBps: 0.8, updatedAt: NOW, source: "stream"
  }));
  const trades = vi.fn(async (marketId: number): Promise<TradesResult> => ({ marketId, trades: [TRADE], population: TAKER_SIDE_LABEL, source: "stream" }));
  const flow = vi.fn(async (marketId: number, interval = "1m"): Promise<FlowResult> => ({
    marketId, interval, bars: [], windows: [], coverage: { firstPrintAt: NOW - 60_000 }, observedAt: NOW
  }));
  const funding = vi.fn(async (marketId: number): Promise<FundingResult> => ({ marketId, funding: { rate: 0.0012, direction: "long", at: NOW - 3_600_000 }, observedAt: NOW, stale: false }));
  return { markets, book, trades, flow, funding, ...overrides } as unknown as LighterServiceLike & Record<string, ReturnType<typeof vi.fn>>;
}

const service = fakeService();
const app = express();
app.use("/api/lighter", createLighterRouter(() => service));
let base = "";
let server: ReturnType<typeof app.listen>;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lighter`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

describe("GET /api/lighter/markets", () => {
  it("returns the service envelope untouched", async () => {
    const { status, body } = await get("/markets");
    expect(status).toBe(200);
    expect(body).toEqual({ markets: [MARKET], observedAt: NOW, stale: false });
  });
});

describe("GET /api/lighter/:marketId/book", () => {
  it("coerces marketId and depth and touches the service", async () => {
    const { status, body } = await get("/12/book?depth=5");
    expect(status).toBe(200);
    expect(service.book).toHaveBeenLastCalledWith(12, 5);
    expect(body).toMatchObject({ marketId: 12, source: "stream", mid: 2503.1, spreadBps: 0.8 });
  });

  it("defaults depth to 20 and rejects depths outside 1..25", async () => {
    await get("/0/book");
    expect(service.book).toHaveBeenLastCalledWith(0, 20);
    expect((await get("/0/book?depth=0")).status).toBe(400);
    expect((await get("/0/book?depth=99")).status).toBe(400);
  });

  it("rejects negative, fractional and non-numeric market ids with a 400 envelope", async () => {
    for (const bad of ["-1", "1.5", "abc"]) {
      const { status, body } = await get(`/${bad}/book`);
      expect(status).toBe(400);
      expect(body.error).toBe("Invalid request");
      expect(Array.isArray(body.issues)).toBe(true);
    }
  });

  it("passes the service's 200 + error envelope through when the book is unavailable", async () => {
    const failing = fakeService({ book: vi.fn(async (marketId: number) => ({ marketId, asks: [], bids: [], mid: null, spreadBps: null, updatedAt: null, source: null, stale: true, error: "upstream 503" })) });
    const local = express();
    local.use("/l", createLighterRouter(() => failing));
    const srv = await new Promise<ReturnType<typeof local.listen>>((resolve) => { const s = local.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const response = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/l/3/book`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ marketId: 3, asks: [], error: "upstream 503", stale: true, source: null });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe("GET /api/lighter/:marketId/trades", () => {
  it("returns the taker-side population label and honours limit", async () => {
    const { status, body } = await get("/7/trades?limit=30");
    expect(status).toBe(200);
    expect(service.trades).toHaveBeenLastCalledWith(7, 30);
    expect(body.population).toBe("LIGHTER · TAKER SIDE");
    expect(body.trades).toEqual([TRADE]);
  });

  it("defaults limit to 50 and caps at 500", async () => {
    await get("/7/trades");
    expect(service.trades).toHaveBeenLastCalledWith(7, 50);
    expect((await get("/7/trades?limit=501")).status).toBe(400);
  });
});

describe("GET /api/lighter/:marketId/flow", () => {
  it("merges flow and funding into one envelope with source lighter", async () => {
    const { status, body } = await get("/0/flow?interval=5m");
    expect(status).toBe(200);
    expect(service.flow).toHaveBeenLastCalledWith(0, "5m");
    expect(service.funding).toHaveBeenLastCalledWith(0);
    expect(body).toEqual({
      marketId: 0, interval: "5m", bars: [], windows: [], coverage: { firstPrintAt: NOW - 60_000 },
      funding: { rate: 0.0012, direction: "long", at: NOW - 3_600_000 }, observedAt: NOW, source: LIGHTER_FLOW_SOURCE
    });
  });

  it("defaults to 1m and rejects intervals outside 1m/5m/15m/1h", async () => {
    await get("/0/flow");
    expect(service.flow).toHaveBeenLastCalledWith(0, "1m");
    expect((await get("/0/flow?interval=4h")).status).toBe(400);
    expect((await get("/0/flow?interval=2m")).status).toBe(400);
  });
});

describe("buildLighterFlow", () => {
  it("unions stale and joins error strings from flow and funding; funding null stays null", async () => {
    const svc = fakeService({
      flow: vi.fn(async (marketId: number, interval: string) => ({ marketId, interval, bars: [], windows: [], coverage: { firstPrintAt: null }, observedAt: NOW, stale: true, error: "bootstrap failed" })),
      funding: vi.fn(async (marketId: number) => ({ marketId, funding: null, observedAt: null, stale: true, error: "timeout" }))
    });
    const result = await buildLighterFlow(svc, 4, "15m");
    expect(result.stale).toBe(true);
    expect(result.error).toBe("bootstrap failed; funding: timeout");
    expect(result.funding).toBeNull();
    expect(result.coverage.firstPrintAt).toBeNull();
  });

  it("omits stale/error keys entirely when both reads are clean", async () => {
    const result = await buildLighterFlow(fakeService(), 4, "1h");
    expect("stale" in result).toBe(false);
    expect("error" in result).toBe(false);
  });
});
