import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PairRow } from "../../../shared/wire";
import { pumpPoolFor } from "../../sources/pumpfun";
import { parseSwapTransaction, poolRefsFromRegistry, RAYDIUM_V4_AUTHORITY, tokenDeltas, type PoolRef } from "./parseSwap";

type Fixture = { file: string; dex: string; pool: string; tx: string; mint: string; geckoSide: "buy" | "sell" | "none"; geckoUsd: number | null };

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Gecko and pump v2 both implied this SOL price at the fixtures' block times. */
const SOL_USD_AT_FIXTURES = 105.13;
const METEORA_4PAN = "4pANrqEvjad4xEghrCbAAJfBm8KyNvYMKk1cuGW8erE4";

const index: Fixture[] = JSON.parse(readFileSync(new URL("./__fixtures__/index.json", import.meta.url), "utf8"));

function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${file}`, import.meta.url), "utf8"));
}

function quotePriceUsd(mint: string): number | null {
  if (mint === SOL) return SOL_USD_AT_FIXTURES;
  if (mint === USDC) return 1;
  return null;
}

function poolRef(fixture: Pick<Fixture, "dex" | "pool" | "mint">): PoolRef {
  const ledgerPair = fixture.dex === "pumpswap" ? pumpPoolFor(fixture.mint) : fixture.pool;
  return { pair: fixture.pool, pairAddress: fixture.pool, dex: fixture.dex, ledgerPair };
}

type Balance = { index: number; mint: string; owner: string; pre: string; post: string; decimals?: number };
type SyntheticOptions = {
  keys: Array<{ pubkey: string; signer?: boolean }>;
  balances: Balance[];
  err?: unknown;
  blockTime?: number;
  lamports?: { pre: number[]; post: number[] };
  instructions?: string[][];
};

function syntheticTx(opts: SyntheticOptions): unknown {
  const balance = (row: Balance, amount: string) => ({
    accountIndex: row.index,
    mint: row.mint,
    owner: row.owner,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: { amount, decimals: row.decimals ?? 6, uiAmount: Number(amount), uiAmountString: amount }
  });
  return {
    blockTime: opts.blockTime,
    meta: {
      err: opts.err ?? null,
      preBalances: opts.lamports?.pre ?? opts.keys.map(() => 0),
      postBalances: opts.lamports?.post ?? opts.keys.map(() => 0),
      preTokenBalances: opts.balances.filter((row) => row.pre !== "").map((row) => balance(row, row.pre)),
      postTokenBalances: opts.balances.filter((row) => row.post !== "").map((row) => balance(row, row.post)),
      innerInstructions: []
    },
    transaction: {
      signatures: ["SyntheticSig111"],
      message: {
        accountKeys: opts.keys.map((key) => ({ pubkey: key.pubkey, signer: key.signer ?? false, writable: true, source: "transaction" })),
        instructions: (opts.instructions ?? []).map((accounts) => ({ programId: "Prog", accounts, data: "" }))
      }
    }
  };
}

describe("parseSwapTransaction against measured fixtures", () => {
  it("index covers the measured dexes", () => {
    expect(index.length).toBeGreaterThan(0);
    expect(new Set(index.map((fixture) => fixture.dex))).toEqual(new Set(["orca", "meteora", "pumpswap", "raydium-clmm"]));
  });

  for (const fixture of index) {
    it(`${fixture.file}: ${fixture.geckoSide === "none" ? "no print" : `one ${fixture.geckoSide}`} for pool ${fixture.pool.slice(0, 8)}`, () => {
      const tx = loadFixture(fixture.file);
      const result = parseSwapTransaction(tx, { mint: fixture.mint, pools: [poolRef(fixture)], quotePriceUsd });
      expect(result.skipped).toBeNull();
      if (fixture.geckoSide === "none") {
        expect(result.prints).toEqual([]);
        return;
      }
      expect(result.prints).toHaveLength(1);
      const [print] = result.prints;
      expect(print.side).toBe(fixture.geckoSide);
      expect(print.tx).toBe(fixture.tx);
      expect(print.pair).toBe(poolRef(fixture).ledgerPair);
      expect(print.chain).toBe("solana");
      expect(print.source).toBe("own");
      expect(print.time).toBe(Number((tx as { blockTime: number }).blockTime) * 1000);
      expect(print.usd).not.toBeNull();
      if (fixture.geckoUsd !== null) {
        expect(Math.abs((print.usd as number) - fixture.geckoUsd) / fixture.geckoUsd).toBeLessThan(0.15);
      }
      // price = usd / |pool token-vault delta| of this very tx; every priced fixture sits in the measured ANSEM band.
      const mintDelta = tokenDeltas(tx).filter((delta) => delta.owner === fixture.pool && delta.mint === fixture.mint).reduce((sum, delta) => sum + delta.delta, 0);
      expect(print.price).toBeCloseTo((print.usd as number) / Math.abs(mintDelta), 12);
      expect(print.price as number).toBeGreaterThan(0.26);
      expect(print.price as number).toBeLessThan(0.271);
    });
  }

  it("pumpswap-2ZxiypZR prices from the measured vault deltas: 2.908797459 SOL for 1141.773729 ANSEM", () => {
    const fixture = index.find((row) => row.file.startsWith("pumpswap-FnzKY6x7-2ZxiypZR")) as Fixture;
    const [print] = parseSwapTransaction(loadFixture(fixture.file), { mint: fixture.mint, pools: [poolRef(fixture)], quotePriceUsd }).prints;
    expect(print.price).toBeCloseTo((2.908797459 * SOL_USD_AT_FIXTURES) / 1141.773729, 9);
  });
});

describe("tokenDeltas", () => {
  it("matches pump v2 baseAmount to the lamport on the pumpswap fixture", () => {
    const fixture = index.find((row) => row.file.startsWith("pumpswap-FnzKY6x7-2ZxiypZR"));
    expect(fixture).toBeDefined();
    const deltas = tokenDeltas(loadFixture(fixture!.file)).filter((delta) => delta.owner === fixture!.pool);
    expect(deltas).toHaveLength(2);
    expect(deltas.find((delta) => delta.mint === fixture!.mint)?.delta).toBeCloseTo(-1141.773729, 6);
    expect(deltas.find((delta) => delta.mint === SOL)?.delta).toBeCloseTo(2.908797459, 9);
  });

  it("treats accounts missing on one side as zero there", () => {
    const tx = syntheticTx({
      keys: [{ pubkey: "user", signer: true }, { pubkey: "created" }, { pubkey: "closed" }],
      balances: [
        { index: 1, mint: "M", owner: "user", pre: "", post: "5000000" },
        { index: 2, mint: "M", owner: "user", pre: "2000000", post: "" }
      ]
    });
    expect(tokenDeltas(tx)).toEqual([
      { account: "created", owner: "user", mint: "M", delta: 5 },
      { account: "closed", owner: "user", mint: "M", delta: -2 }
    ]);
  });

  it("returns an empty list for malformed input", () => {
    expect(tokenDeltas(null)).toEqual([]);
    expect(tokenDeltas({ meta: { postTokenBalances: [{ accountIndex: "x" }] } })).toEqual([]);
  });
});

describe("parseSwapTransaction synthetic cases", () => {
  const MINT = "MintA";
  const pool = (address: string, ledgerPair = address): PoolRef => ({ pair: address, pairAddress: address, dex: "test", ledgerPair });

  function swapTx(extra: Partial<SyntheticOptions> = {}): unknown {
    return syntheticTx({
      blockTime: 1_700_000_000,
      keys: [{ pubkey: "user", signer: true }, { pubkey: "poolA" }, { pubkey: "vaultA_mint" }, { pubkey: "vaultA_sol" }, { pubkey: "userAta" }],
      balances: [
        { index: 2, mint: MINT, owner: "poolA", pre: "1000000000", post: "900000000" },
        { index: 3, mint: SOL, owner: "poolA", pre: "5000000000", post: "6000000000", decimals: 9 },
        { index: 4, mint: MINT, owner: "user", pre: "0", post: "100000000" }
      ],
      ...extra
    });
  }

  it("skips failed transactions", () => {
    const tx = swapTx({ err: { InstructionError: [2, { Custom: 6001 }] } });
    expect(parseSwapTransaction(tx, { mint: MINT, pools: [pool("poolA")], quotePriceUsd })).toEqual({
      prints: [],
      unattributed: 0,
      skipped: "failed tx"
    });
  });

  it("reports malformed input and missing signature/time without throwing", () => {
    expect(parseSwapTransaction(undefined, { mint: MINT, pools: [], quotePriceUsd }).skipped).toBe("malformed tx");
    const noSig = swapTx() as { transaction: { signatures: string[] } };
    noSig.transaction.signatures = [];
    expect(parseSwapTransaction(noSig, { mint: MINT, pools: [], quotePriceUsd }).skipped).toBe("missing signature");
    expect(parseSwapTransaction(swapTx({ blockTime: undefined }), { mint: MINT, pools: [], quotePriceUsd }).skipped).toBe("missing block time");
  });

  it("uses ctx.blockTimeMs when the tx carries no blockTime", () => {
    const result = parseSwapTransaction(swapTx({ blockTime: undefined }), { mint: MINT, pools: [pool("poolA")], quotePriceUsd, blockTimeMs: 42_000 });
    expect(result.skipped).toBeNull();
    // 100 tokens (1e8 raw at 6 decimals) left the vault for 1 SOL: price = SOL/USD / 100.
    expect(result.prints[0]).toMatchObject({ side: "buy", time: 42_000, usd: SOL_USD_AT_FIXTURES, tx: "SyntheticSig111", price: SOL_USD_AT_FIXTURES / 100 });
  });

  it("prices in null when the quote mint is not priceable, and then carries no price key at all", () => {
    const result = parseSwapTransaction(swapTx(), { mint: MINT, pools: [pool("poolA")], quotePriceUsd: () => null });
    expect(result.prints[0].usd).toBeNull();
    expect(result.prints[0].side).toBe("buy");
    expect("price" in result.prints[0]).toBe(false);
  });

  it("emits one print per Tier A pool when a route touches two pools", () => {
    const fixture = index.find((row) => row.file.startsWith("orca-CNTPTpyt-5uRJUzU2"));
    expect(fixture).toBeDefined();
    const pools = [poolRef(fixture!), { pair: METEORA_4PAN, pairAddress: METEORA_4PAN, dex: "meteora", ledgerPair: METEORA_4PAN }];
    const result = parseSwapTransaction(loadFixture(fixture!.file), { mint: fixture!.mint, pools, quotePriceUsd });
    expect(result.prints.map((print) => print.pair)).toEqual([fixture!.pool, METEORA_4PAN]);
    expect(result.prints.every((print) => print.side === "sell" && print.tx === fixture!.tx)).toBe(true);
    expect(result.prints[1].usd).toBeCloseTo(21.147 * SOL_USD_AT_FIXTURES, 0);
    // meteora 4pAN leg: ANSEM +8243.1 / WSOL -21.147 (index.json note).
    expect(result.prints[1].price).toBeCloseTo((21.147 * SOL_USD_AT_FIXTURES) / 8243.1, 4);
    expect(result.unattributed).toBe(0);
  });

  it("counts token moves on non-Tier-A, non-signer accounts as unattributed", () => {
    const tx = syntheticTx({
      blockTime: 1_700_000_000,
      keys: [{ pubkey: "user", signer: true }, { pubkey: "poolA" }, { pubkey: "vaultA_mint" }, { pubkey: "vaultA_sol" }, { pubkey: "userAta" }, { pubkey: "poolB" }, { pubkey: "vaultB_mint" }],
      balances: [
        { index: 2, mint: MINT, owner: "poolA", pre: "1000000000", post: "900000000" },
        { index: 3, mint: SOL, owner: "poolA", pre: "5000000000", post: "6000000000", decimals: 9 },
        { index: 4, mint: MINT, owner: "user", pre: "0", post: "150000000" },
        { index: 6, mint: MINT, owner: "poolB", pre: "1000000000", post: "950000000" }
      ]
    });
    const result = parseSwapTransaction(tx, { mint: MINT, pools: [pool("poolA")], quotePriceUsd });
    expect(result.prints).toHaveLength(1);
    expect(result.unattributed).toBe(1);
    const tierB = index.find((row) => row.file.startsWith("orca-CNTPTpyt-2fojNb14"))!;
    const meteoraOnly = parseSwapTransaction(loadFixture(tierB.file), { mint: tierB.mint, pools: [pool(METEORA_4PAN)], quotePriceUsd });
    expect(meteoraOnly.prints).toHaveLength(1);
    expect(meteoraOnly.unattributed).toBe(2);
  });

  it("emits pump-venue prints under the pump pseudo-pair so pump v2 dedupes them", () => {
    const fixture = index.find((row) => row.dex === "pumpswap")!;
    const pumpPool = { pair: fixture.pool, pairAddress: fixture.pool, dex: "pumpswap", ledgerPair: pumpPoolFor(fixture.mint) };
    const result = parseSwapTransaction(loadFixture(fixture.file), { mint: fixture.mint, pools: [pumpPool], quotePriceUsd });
    expect(result.prints).toHaveLength(1);
    expect(result.prints[0].pair).toBe(`pumpfun:${fixture.mint}`);
  });

  it("requires both vaults to move in opposite directions", () => {
    const oneSided = swapTx({
      balances: [
        { index: 2, mint: MINT, owner: "poolA", pre: "1000000000", post: "1000000000" },
        { index: 3, mint: SOL, owner: "poolA", pre: "5000000000", post: "6000000000", decimals: 9 }
      ]
    });
    expect(parseSwapTransaction(oneSided, { mint: MINT, pools: [pool("poolA")], quotePriceUsd }).prints).toEqual([]);
    const sameSign = swapTx({
      balances: [
        { index: 2, mint: MINT, owner: "poolA", pre: "1000000000", post: "1100000000" },
        { index: 3, mint: SOL, owner: "poolA", pre: "5000000000", post: "6000000000", decimals: 9 }
      ]
    });
    expect(parseSwapTransaction(sameSign, { mint: MINT, pools: [pool("poolA")], quotePriceUsd }).prints).toEqual([]);
  });

  it("attributes Raydium AMM v4 authority-owned vaults only when the pool shares their instruction", () => {
    const balances: Balance[] = [
      { index: 2, mint: MINT, owner: RAYDIUM_V4_AUTHORITY, pre: "1000000000", post: "1200000000" },
      { index: 3, mint: USDC, owner: RAYDIUM_V4_AUTHORITY, pre: "5000000", post: "4000000" }
    ];
    const keys = [{ pubkey: "user", signer: true }, { pubkey: "poolV4" }, { pubkey: "v4_mint" }, { pubkey: "v4_usdc" }];
    const linked = syntheticTx({ blockTime: 1, keys, balances, instructions: [["poolV4", "v4_mint", "v4_usdc", "user"]] });
    const result = parseSwapTransaction(linked, { mint: MINT, pools: [pool("poolV4")], quotePriceUsd });
    expect(result.prints).toHaveLength(1);
    expect(result.prints[0]).toMatchObject({ side: "sell", usd: 1 });
    const unlinked = syntheticTx({ blockTime: 1, keys, balances, instructions: [["other", "v4_mint"]] });
    const miss = parseSwapTransaction(unlinked, { mint: MINT, pools: [pool("poolV4")], quotePriceUsd });
    expect(miss.prints).toEqual([]);
    expect(miss.unattributed).toBe(1);
  });

  it("falls back to the pool account's lamport delta when no quote vault exists", () => {
    const tx = syntheticTx({
      blockTime: 1,
      keys: [{ pubkey: "user", signer: true }, { pubkey: "poolN" }, { pubkey: "vaultN_mint" }],
      balances: [{ index: 2, mint: MINT, owner: "poolN", pre: "1000000000", post: "1100000000" }],
      lamports: { pre: [0, 10_000_000_000, 0], post: [0, 8_000_000_000, 0] }
    });
    const result = parseSwapTransaction(tx, { mint: MINT, pools: [pool("poolN")], quotePriceUsd });
    expect(result.prints).toHaveLength(1);
    expect(result.prints[0]).toMatchObject({ side: "sell", usd: 2 * SOL_USD_AT_FIXTURES });
  });
});

describe("poolRefsFromRegistry", () => {
  const row = (pairAddress: string, dex: string, tier: "A" | "B"): PairRow => ({
    chain: "solana",
    dex,
    pairAddress,
    baseMint: "M",
    quoteMint: null,
    liquidityUsd: null,
    volume24Usd: null,
    share24: null,
    txns: { m5: null, h1: null, h6: null, h24: null },
    tier,
    sources: []
  });

  it("maps pump-venue pools to the pseudo-pair and drops Tier B and the pseudo-pair row", () => {
    const refs = poolRefsFromRegistry([row("pumpfun:M", "pumpfun", "A"), row("Fnz", "pumpswap", "B"), row("6e7", "meteora", "A"), row("CNT", "orca", "B")], "M");
    expect(refs).toEqual([
      { pair: "Fnz", pairAddress: "Fnz", dex: "pumpswap", ledgerPair: "pumpfun:M" },
      { pair: "6e7", pairAddress: "6e7", dex: "meteora", ledgerPair: "6e7" }
    ]);
  });

  it("keeps a pump-venue pool under its own address when no pseudo-pair exists", () => {
    expect(poolRefsFromRegistry([row("Fnz", "pumpswap", "A"), row("CNT", "orca", "B")], "M")).toEqual([
      { pair: "Fnz", pairAddress: "Fnz", dex: "pumpswap", ledgerPair: "Fnz" }
    ]);
  });
});
