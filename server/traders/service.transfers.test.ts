import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraderKind } from "../../shared/wire.js";
import type { TraderFill } from "./book.js";
import { DECIMALS_SELECTOR, Erc20Meta } from "./erc20Meta.js";
import { HANDLES_POPULATION, HandleBook, type HandleBookStats, type HandleEntry } from "./handles.js";
import {
  SEED_DRAIN_BATCH,
  SEED_DRAIN_MS,
  SEED_MAX_ATTEMPTS,
  SEED_PROVENANCE_TRENCHES,
  TraderService,
  type ClassifierLike,
  type HandlesLike,
  type ReceiptsLike
} from "./service.js";

const NOW = 1_800_000_000_000;
const TOKEN = "0x3333333333333333333333333333333333333333";
const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const W3 = "0x4444444444444444444444444444444444444444";
const W4 = "0x5555555555555555555555555555555555555555";

class FakeClassifier implements ClassifierLike {
  calls: Array<[string, string | undefined]> = [];
  known = new Map<string, TraderKind>();
  constructor(private readonly answers: Record<string, TraderKind | null>) {}
  async classify(address: string, opts?: { priority?: "high" | "low" }): Promise<TraderKind | null> {
    this.calls.push([address, opts?.priority]);
    const kind = this.answers[address] ?? null;
    if (kind) this.known.set(address, kind);
    return kind;
  }
  peek(address: string): TraderKind | undefined {
    return this.known.get(address);
  }
  stats(): unknown {
    return { pending: 0 };
  }
}

class FakeReceipts implements ReceiptsLike {
  async get(): Promise<null> {
    return null;
  }
  stats(): unknown {
    return {};
  }
}

class FakeHandles implements HandlesLike {
  constructor(private readonly entries: Record<string, HandleEntry> = {}) {}
  get(address: string): HandleEntry | null {
    return this.entries[address] ?? null;
  }
  stats(): HandleBookStats {
    const status = { rows: 0, lastOkAt: null, lastError: null };
    return { entries: Object.keys(this.entries).length, population: HANDLES_POPULATION, traders: status, tape: status, learned: 0 };
  }
}

/** eth_call answers for TOKEN only: decimals 18, symbol "TKN" (ABI string); every other token answers empty data. */
function tokenRpc() {
  const symbol = Buffer.from("TKN").toString("hex");
  const abiString = `0x${(32).toString(16).padStart(64, "0")}${(3).toString(16).padStart(64, "0")}${symbol.padEnd(64, "0")}`;
  return {
    call: async (_method: string, params: unknown[]) => {
      const [{ to, data }] = params as [{ to: string; data: string }];
      if (to !== TOKEN) return "0x";
      return data === DECIMALS_SELECTOR ? `0x${(18).toString(16).padStart(64, "0")}` : abiString;
    }
  };
}

function service(answers: Record<string, TraderKind | null>, handles: HandlesLike = new FakeHandles()) {
  const classifier = new FakeClassifier(answers);
  const erc20Meta = new Erc20Meta({ rpc: tokenRpc(), now: () => NOW });
  const svc = new TraderService({ rpcUrl: "https://rpc.test", classifier, receipts: new FakeReceipts(), handles, erc20Meta, now: () => NOW, log: vi.fn() });
  return { svc, classifier };
}

function fill(trader: string, kind: TraderKind | null, extra: Partial<TraderFill> = {}): TraderFill {
  return { chain: "robinhood", pair: `fomo:${TOKEN}`, tx: "0xt1", time: NOW - 1000, side: "buy", usd: 12.5, price: 0.5, source: "own", trader, token: TOKEN, handle: null, followers: null, kind, ...extra };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TraderService seeding", () => {
  it("adds seeded wallets to the transfer population at once and classifies them on the low lane a few per drain", async () => {
    vi.useFakeTimers();
    const h = service({ [W1]: "fomo", [W2]: "other", [W3]: null });
    const before = h.svc.populationVersion();
    expect(h.svc.seed([W1, W2.toUpperCase(), W3, "nope", W1], SEED_PROVENANCE_TRENCHES)).toBe(3);
    expect(h.svc.populationVersion()).toBe(before + 1);
    expect(h.svc.transferWallets()).toEqual([W1, W2, W3]);
    expect(h.svc.status().population).toMatchObject({ classified: 0, seeded: 3, seedQueue: 3 });
    expect(h.classifier.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(SEED_DRAIN_MS);
    expect(h.classifier.calls.slice(0, 3)).toEqual([[W1, "low"], [W2, "low"], [W3, "low"]]);
    expect(h.svc.population.has(W1)).toBe(true);
    expect(h.svc.transferWallets()).toEqual([W1, W3]);
    expect(h.svc.status().counters).toMatchObject({ seedChecked: 3, seedFomo: 1, seedFailed: 0 });
    // W3 keeps failing: retried until SEED_MAX_ATTEMPTS, then given up and counted.
    await vi.advanceTimersByTimeAsync(SEED_DRAIN_MS * SEED_MAX_ATTEMPTS);
    expect(h.classifier.calls.filter(([address]) => address === W3)).toHaveLength(SEED_MAX_ATTEMPTS);
    expect(h.svc.status()).toMatchObject({ population: { classified: 1, seeded: 3, seedQueue: 0 }, counters: { seedFailed: 1 } });
    expect(h.svc.seeded.get(W1)).toMatchObject({ provenance: SEED_PROVENANCE_TRENCHES, attempts: 0 });
  });

  it("drains at most SEED_DRAIN_BATCH wallets per tick and lists classified wallets first when building the population", async () => {
    vi.useFakeTimers();
    const wallets = Array.from({ length: SEED_DRAIN_BATCH + 2 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    const h = service(Object.fromEntries(wallets.map((wallet) => [wallet, "fomo" as const])));
    h.svc.seed(wallets, "test");
    await vi.advanceTimersByTimeAsync(SEED_DRAIN_MS);
    expect(h.classifier.calls).toHaveLength(SEED_DRAIN_BATCH);
    await vi.advanceTimersByTimeAsync(SEED_DRAIN_MS);
    expect(h.classifier.calls).toHaveLength(wallets.length);
    expect(h.svc.transferWallets()[0]).toBe(wallets[wallets.length - 1]);
    expect(h.svc.transferWallets()).toHaveLength(wallets.length);
  });

  it("relabels a seeded wallet's earlier book rows once its 7702 check passes", async () => {
    vi.useFakeTimers();
    const h = service({ [W4]: "fomo" });
    h.svc.seed([W4], "test");
    expect(h.svc.recordTransferFills([fill(W4, null)])).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect(h.svc.book.tape("robinhood", 10, { kind: "fomo" })).toEqual([]);
    await vi.advanceTimersByTimeAsync(SEED_DRAIN_MS);
    expect(h.svc.book.tape("robinhood", 10, { kind: "fomo" })).toHaveLength(1);
  });
});

describe("TraderService.recordTransferFills / fillsForToken", () => {
  it("books every accepted fill, sends only proven-FOMO fills to the FOMO ledger under fomo:<token> with dex \"\", and counts unproven ones", () => {
    const h = service({});
    const result = h.svc.recordTransferFills([fill(W1, "fomo"), fill(W2, null, { tx: "0xt2" }), fill(W1, "fomo"), { ...fill(W1, "fomo"), trader: "" }]);
    expect(result).toEqual({ accepted: 2, duplicates: 1, rejected: 1 });
    expect(h.svc.book.size()).toEqual({ wallets: 2, fills: 2 });
    expect(h.svc.fomoLedger.recentPrints("robinhood", `fomo:${TOKEN}`)).toHaveLength(1);
    expect(h.svc.fomoLedger.recentPrints("robinhood", `fomo:${TOKEN}`)[0]).toMatchObject({ tx: "0xt1", usd: 12.5, price: 0.5, trader: { address: W1, kind: "fomo" } });
    expect(h.svc.dexOf("robinhood", `fomo:${TOKEN}`)).toBe("");
    expect(h.svc.status().counters).toMatchObject({ transferFills: 2, transferUnproven: 1 });
  });

  it("rejects a transfer fill R3 already recorded for the same tx+wallet+token+side under a pool pair", () => {
    const h = service({});
    expect(h.svc.book.record(fill(W1, "fomo", { pair: "0xpool", usd: 99 }))).toBe("accepted");
    expect(h.svc.recordTransferFills([fill(W1, "fomo")])).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    expect(h.svc.book.stats("robinhood", W1)?.buyUsd).toBe(99);
  });

  it("fillsForToken answers FOMO fills of the token across pairs with erc20Meta symbol, price, usd provenance and known handles", async () => {
    const handles = new FakeHandles({ [W1]: { handle: "alpha", followers: 7, profileUrl: null, source: "traders" } });
    const h = service({}, handles);
    await h.svc.erc20Meta.resolve(TOKEN);
    h.svc.recordTransferFills([fill(W1, "fomo", { usdVia: "hub_leg" }), fill(W2, null, { tx: "0xt2" })]);
    h.svc.book.record(fill(W1, "fomo", { pair: "0xpool", tx: "0xt3", usd: 3, price: null }));
    const fills = h.svc.fillsForToken("robinhood", TOKEN.toUpperCase(), 10);
    expect(fills).toHaveLength(2);
    expect(fills.map((row) => row.pair)).toEqual(["0xpool", `fomo:${TOKEN}`]);
    expect(fills[1]).toMatchObject({ chain: "robinhood", token: TOKEN, dex: "", tx: "0xt1", usd: 12.5, price: 0.5, usdVia: "hub_leg", symbol: "TKN", trader: { address: W1, kind: "fomo", handle: "alpha", followers: 7 } });
    expect(fills[0].price).toBeUndefined();
    expect("usdVia" in fills[0]).toBe(false);
    expect(h.svc.fomoLedger.recentPrints("robinhood", `fomo:${TOKEN}`)[0]).not.toHaveProperty("usdVia");
    expect(h.svc.fillsForToken("robinhood", "0x9999999999999999999999999999999999999999", 10)).toEqual([]);
  });
});

describe("HandleBook -> seed wiring", () => {
  it("hands the lowercase wallets of a loaded traders list to onTraders (147 in the 2026-09-06 capture)", async () => {
    const traders = JSON.parse(readFileSync(new URL("./__fixtures__/r4/trenches-traders.json", import.meta.url), "utf8")) as unknown[];
    const seeded: string[][] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("/traders") ? traders : []), { status: 200 }));
    const book = new HandleBook({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW, onTraders: (wallets) => seeded.push(wallets) });
    await book.refresh(true);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toHaveLength(147);
    expect(seeded[0].every((wallet) => /^0x[0-9a-f]{40}$/.test(wallet))).toBe(true);
    const h = service({});
    expect(h.svc.seed(seeded[0], SEED_PROVENANCE_TRENCHES)).toBe(147);
    expect(h.svc.transferWallets()).toHaveLength(147);
  });
});
