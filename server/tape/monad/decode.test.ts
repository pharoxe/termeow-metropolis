import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NATIVE_DECIMALS, NATIVE_MON, POOL_MANAGER } from "./pools.js";
import {
  decodeSwapLog,
  logKey,
  SWAP_TOPICS,
  toSignedBigInt,
  type EvmLog,
  type EvmPoolRef,
  type SwapKind
} from "./decode";

type Fixture = {
  file: string;
  kind: SwapKind;
  pool: string;
  tx: string;
  token: string;
  quote: string;
  geckoSide: "buy" | "sell" | "unknown";
  geckoUsd: number | null;
  geckoTime: string;
  geckoFromAmount: string;
  geckoToAmount: string;
  blockFile: string | null;
  poolFile: string | null;
};
type PoolFile = { decoded: { token0: string; token1: string; decimals0: number; decimals1: number } };
type DexPair = { pairAddress: string; priceUsd: string; priceNative: string };

const FATCOIN = "0x12d5ee7917ca430073c3a638ee1e6f0648a98a01";

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${file}`, import.meta.url), "utf8")) as T;
}

const index = loadJson<Fixture[]>("index.json");
const dexPairs = loadJson<DexPair[]>("dexscreener-fatcoin.json");

/** The registry stores DexScreener's pairAddress verbatim; own prints must reuse that exact string. */
function registryPairAddress(pool: string): string {
  const row = dexPairs.find((pair) => pair.pairAddress.toLowerCase() === pool.toLowerCase());
  if (!row) throw new Error(`no DexScreener row for ${pool}`);
  return row.pairAddress;
}

/** quoteUsd = priceUsd / priceNative from the DexScreener row, the same derivation the live tape will use. */
function quoteUsdFromDexScreener(pool: string): number {
  const row = dexPairs.find((pair) => pair.pairAddress.toLowerCase() === pool.toLowerCase());
  if (!row) throw new Error(`no DexScreener row for ${pool}`);
  return Number(row.priceUsd) / Number(row.priceNative);
}

function decimalsOf(fixture: Fixture): { tokenDecimals: number; quoteDecimals: number } {
  if (fixture.poolFile === null) return { tokenDecimals: 18, quoteDecimals: NATIVE_DECIMALS };
  const { decoded } = loadJson<PoolFile>(fixture.poolFile);
  const tokenIs0 = decoded.token0.toLowerCase() === fixture.token.toLowerCase();
  return {
    tokenDecimals: tokenIs0 ? decoded.decimals0 : decoded.decimals1,
    quoteDecimals: tokenIs0 ? decoded.decimals1 : decoded.decimals0
  };
}

/** currency0 < currency1 by address in every Uniswap version; native ETH (0x0) therefore always sorts first. */
function poolRefFor(fixture: Fixture): EvmPoolRef {
  const pairAddress = registryPairAddress(fixture.pool);
  return {
    pair: pairAddress,
    pairAddress,
    dex: "uniswap",
    ledgerPair: pairAddress,
    kind: fixture.kind,
    token: fixture.token.toLowerCase(),
    quote: fixture.quote.toLowerCase(),
    tokenIsCurrency0: fixture.token.toLowerCase() < fixture.quote.toLowerCase(),
    ...decimalsOf(fixture)
  };
}

function poolsFor(refs: EvmPoolRef[]): Map<string, EvmPoolRef> {
  return new Map(refs.map((ref) => [ref.pairAddress.toLowerCase(), ref]));
}

function timeMsFor(fixture: Fixture): number {
  if (fixture.blockFile === null) return Date.parse(fixture.geckoTime);
  return Number(BigInt(loadJson<{ timestamp: string }>(fixture.blockFile).timestamp)) * 1000;
}

function receiptLogs(file: string): EvmLog[] {
  return loadJson<{ logs: EvmLog[] }>(file).logs;
}

function word(value: bigint): string {
  const mask = (1n << 256n) - 1n;
  return (value & mask).toString(16).padStart(64, "0");
}

function syntheticLog(kind: SwapKind, poolOrId: string, words: bigint[], overrides: Partial<EvmLog> = {}): EvmLog {
  const isV4 = kind === "v4";
  return {
    address: isV4 ? POOL_MANAGER : poolOrId,
    topics: isV4 ? [SWAP_TOPICS.v4, poolOrId, word(0n)] : [SWAP_TOPICS[kind], `0x${word(1n)}`, `0x${word(2n)}`],
    data: `0x${words.map(word).join("")}`,
    transactionHash: "0xabc",
    blockNumber: "0x1",
    logIndex: "0x7",
    ...overrides
  };
}

const V4_ID = "0x70b5b746dc36c648893dafdf4b98d708a07673dfc1b3a0bb9dd70e36c0569f68";
const V3_POOL = "0x353F2BD390D8db7BFC9B3dD389F8B71e8DF524fa";
const ETH_USD = 2500;
const ctx = { timeMs: 1_788_689_965_000, quoteUsd: (quote: string) => (quote === NATIVE_MON ? ETH_USD : null) };

function v4Ref(tokenIsCurrency0: boolean, overrides: Partial<EvmPoolRef> = {}): EvmPoolRef {
  return {
    pair: V4_ID,
    pairAddress: V4_ID,
    dex: "uniswap",
    ledgerPair: V4_ID,
    kind: "v4",
    token: FATCOIN,
    quote: NATIVE_MON,
    tokenIsCurrency0,
    tokenDecimals: 18,
    quoteDecimals: 18,
    ...overrides
  };
}

describe("decodeSwapLog against GeckoTerminal ground truth", () => {
  for (const fixture of index.filter((entry) => entry.geckoSide !== "unknown")) {
    it(`${fixture.kind} ${fixture.tx.slice(0, 10)} decodes as ${fixture.geckoSide}`, () => {
      const ref = poolRefFor(fixture);
      const pools = poolsFor([ref]);
      const timeMs = timeMsFor(fixture);
      const quoteUsd = (quote: string) => (quote === ref.quote ? quoteUsdFromDexScreener(fixture.pool) : null);
      const prints = receiptLogs(fixture.file)
        .map((log) => decodeSwapLog(log, pools, { timeMs, quoteUsd }))
        .filter((print) => print !== null);

      expect(prints).toHaveLength(1);
      const [print] = prints;
      expect(print.side).toBe(fixture.geckoSide);
      expect(print.chain).toBe("monad");
      expect(print.source).toBe("own");
      expect(print.tx).toBe(fixture.tx);
      expect(print.time).toBe(timeMs);
      expect(print.pair).toBe(registryPairAddress(fixture.pool));
      expect(print.usd).not.toBeNull();
      const usd = print.usd as number;
      const gecko = fixture.geckoUsd as number;
      expect(Math.abs(usd - gecko) / gecko).toBeLessThan(0.15);
      // price = usd / token units; Gecko's whole-token leg (to_token on a buy, from_token on a sell) is the decimals oracle.
      const geckoTokenUnits = Number(fixture.geckoSide === "buy" ? fixture.geckoToAmount : fixture.geckoFromAmount);
      expect(((print.price as number) * geckoTokenUnits) / usd).toBeCloseTo(1, 8);
    });
  }

  it("v3 0x6715fb00: 20.660502 USDG bought 1035.39874162462 FATCOIN (18 dec) -> price 0.019954 at USDG = 1", () => {
    const fixture = index.find((entry) => entry.tx.startsWith("0x6715fb00")) as Fixture;
    const print = receiptLogs(fixture.file)
      .map((log) => decodeSwapLog(log, poolsFor([poolRefFor(fixture)]), { timeMs: 0, quoteUsd: () => 1 }))
      .find((entry) => entry !== null);
    expect(print?.usd).toBeCloseTo(20.660502, 6);
    expect(print?.price).toBeCloseTo(20.660502 / 1035.39874162462, 9);
  });

  it("v2/v3 pools keep DexScreener checksum casing on the print pair while matching logs case-insensitively", () => {
    const fixture = index.find((entry) => entry.kind === "v3") as Fixture;
    const ref = poolRefFor(fixture);
    expect(ref.ledgerPair).toBe(V3_POOL);
    expect(ref.ledgerPair).not.toBe(V3_POOL.toLowerCase());
    const print = receiptLogs(fixture.file)
      .map((log) => decodeSwapLog(log, poolsFor([ref]), { timeMs: 0, quoteUsd: () => 1 }))
      .find((entry) => entry !== null);
    expect(print?.pair).toBe(V3_POOL);
  });

  it("emits one print per matching pool log in a multi-hop tx and ignores other poolIds", () => {
    const fixture = index.find((entry) => entry.tx.startsWith("0xa72a4c2f")) as Fixture;
    const logs = receiptLogs(fixture.file);
    const v4Logs = logs.filter((log) => log.topics[0] === SWAP_TOPICS.v4);
    expect(v4Logs.length).toBeGreaterThan(1);
    const prints = logs
      .map((log) => decodeSwapLog(log, poolsFor([poolRefFor(fixture)]), { timeMs: 0, quoteUsd: () => null }))
      .filter((print) => print !== null);
    expect(prints).toHaveLength(1);
    expect(prints[0].usd).toBeNull();
  });
});

describe("toSignedBigInt", () => {
  it("decodes two's complement negatives at 256 and 128 bits", () => {
    expect(toSignedBigInt(`0x${"f".repeat(64)}`, 256)).toBe(-1n);
    expect(toSignedBigInt(`0x${"f".repeat(64)}`, 128)).toBe(-1n);
    expect(toSignedBigInt(`0x${"f".repeat(32)}${"0".repeat(32)}`, 256)).toBe(-(1n << 128n));
    expect(toSignedBigInt(`0x8${"0".repeat(63)}`, 256)).toBe(-(1n << 255n));
    expect(toSignedBigInt(`0x7${"f".repeat(63)}`, 256)).toBe((1n << 255n) - 1n);
    expect(toSignedBigInt("0x2a", 256)).toBe(42n);
    expect(toSignedBigInt(word(-397205391124779053n), 128)).toBe(-397205391124779053n);
  });

  it("rejects non-hex input", () => {
    expect(() => toSignedBigInt("0xzz", 256)).toThrow();
    expect(() => toSignedBigInt("", 256)).toThrow();
  });
});

describe("decodeSwapLog synthetic cases", () => {
  it("returns null for an unknown pool", () => {
    const log = syntheticLog("v4", `0x${"ab".repeat(32)}`, [-1n, 1n, 0n, 0n, 0n, 0n]);
    expect(decodeSwapLog(log, poolsFor([v4Ref(false)]), ctx)).toBeNull();
    const v3 = syntheticLog("v3", `0x${"cd".repeat(20)}`, [-1n, 1n, 0n, 0n, 0n]);
    expect(decodeSwapLog(v3, new Map(), ctx)).toBeNull();
  });

  it("returns null for a wrong topic or a kind mismatch", () => {
    const wrongTopic = syntheticLog("v4", V4_ID, [-1n, 1n, 0n, 0n, 0n, 0n], {
      topics: [`0x${"11".repeat(32)}`, V4_ID, word(0n)]
    });
    expect(decodeSwapLog(wrongTopic, poolsFor([v4Ref(false)]), ctx)).toBeNull();
    const v3ShapedLog = syntheticLog("v3", V4_ID, [-1n, 1n, 0n, 0n, 0n]);
    expect(decodeSwapLog(v3ShapedLog, poolsFor([v4Ref(false)]), ctx)).toBeNull();
  });

  it("returns null for a v4 Swap topic not emitted by the PoolManager", () => {
    const log = syntheticLog("v4", V4_ID, [-1n, 1n, 0n, 0n, 0n, 0n], { address: `0x${"ee".repeat(20)}` });
    expect(decodeSwapLog(log, poolsFor([v4Ref(false)]), ctx)).toBeNull();
  });

  it("returns null for a zero token amount or truncated data", () => {
    const zero = syntheticLog("v4", V4_ID, [5n, 0n, 0n, 0n, 0n, 0n]);
    expect(decodeSwapLog(zero, poolsFor([v4Ref(false)]), ctx)).toBeNull();
    const short = syntheticLog("v4", V4_ID, [-1n, 1n, 0n]);
    expect(decodeSwapLog(short, poolsFor([v4Ref(false)]), ctx)).toBeNull();
    const ragged = syntheticLog("v4", V4_ID, [-1n, 1n, 0n, 0n, 0n, 0n], { data: "0x123" });
    expect(decodeSwapLog(ragged, poolsFor([v4Ref(false)]), ctx)).toBeNull();
    const v2Zero = syntheticLog("v2", `0x${"cd".repeat(20)}`, [0n, 0n, 0n, 0n]);
    const v2Ref = v4Ref(false, { kind: "v2", pairAddress: `0x${"cd".repeat(20)}` });
    expect(decodeSwapLog(v2Zero, poolsFor([v2Ref]), ctx)).toBeNull();
  });

  it("v4 with token as currency1: positive amount1 is a buy, negative is a sell, priced from amount0", () => {
    const eth = 397205391124779053n; // 0.397205 ETH
    const buy = syntheticLog("v4", V4_ID, [-eth, 49122n * 10n ** 18n, 0n, 0n, 117336n, 9991n]);
    const buyPrint = decodeSwapLog(buy, poolsFor([v4Ref(false)]), ctx);
    expect(buyPrint?.side).toBe("buy");
    expect(buyPrint?.usd).toBeCloseTo(0.397205391124779053 * ETH_USD, 3);
    expect(buyPrint?.price).toBeCloseTo((0.397205391124779053 * ETH_USD) / 49122, 9);
    expect(buyPrint?.pair).toBe(V4_ID);
    expect(buyPrint?.time).toBe(ctx.timeMs);
    const sell = syntheticLog("v4", V4_ID, [eth, -(50000n * 10n ** 18n), 0n, 0n, 0n, 0n]);
    expect(decodeSwapLog(sell, poolsFor([v4Ref(false)]), ctx)?.side).toBe("sell");
  });

  it("v4 with token as currency0 flips which word is the token leg", () => {
    const usdc = 1_500_000n; // 1.5 USDC at 6 decimals
    const ref = v4Ref(true, { quote: `0x${"aa".repeat(20)}`, quoteDecimals: 6 });
    const pools = poolsFor([ref]);
    const price = { ...ctx, quoteUsd: () => 1 };
    const buy = syntheticLog("v4", V4_ID, [1000n * 10n ** 18n, -usdc, 0n, 0n, 0n, 0n]);
    const buyPrint = decodeSwapLog(buy, pools, price);
    expect(buyPrint?.side).toBe("buy");
    expect(buyPrint?.usd).toBeCloseTo(1.5, 6);
    expect(buyPrint?.price).toBeCloseTo(1.5 / 1000, 9);
    const sell = syntheticLog("v4", V4_ID, [-(1000n * 10n ** 18n), usdc, 0n, 0n, 0n, 0n]);
    expect(decodeSwapLog(sell, pools, price)?.side).toBe("sell");
  });

  it("v3 uses the pool perspective: negative token amount is a buy", () => {
    const ref = v4Ref(true, { kind: "v3", pairAddress: V3_POOL, ledgerPair: V3_POOL, quote: `0x${"aa".repeat(20)}`, quoteDecimals: 6 });
    const pools = poolsFor([ref]);
    const price = { ...ctx, quoteUsd: () => 1 };
    const buy = syntheticLog("v3", V3_POOL.toLowerCase(), [-(1035n * 10n ** 18n), 20_660_502n, 0n, 0n, 0n]);
    const buyPrint = decodeSwapLog(buy, pools, price);
    expect(buyPrint?.side).toBe("buy");
    expect(buyPrint?.usd).toBeCloseTo(20.660502, 6);
    expect(buyPrint?.pair).toBe(V3_POOL);
    const sell = syntheticLog("v3", V3_POOL, [1543n * 10n ** 18n, -30_724_173n, 0n, 0n, 0n]);
    expect(decodeSwapLog(sell, pools, price)?.side).toBe("sell");
  });

  it("v2 reads the in/out legs and prices the nonzero quote leg", () => {
    const pool = "0x7bA7D2A2D549BbB699fEAD825298b87fEa9f0a31";
    const weth = `0x${"0b".repeat(20)}`;
    const ref = v4Ref(false, { kind: "v2", pairAddress: pool, ledgerPair: pool, quote: weth });
    const pools = poolsFor([ref]);
    const price = { ...ctx, quoteUsd: (quote: string) => (quote === weth ? ETH_USD : null) };
    const sell = syntheticLog("v2", pool.toLowerCase(), [0n, 20n * 10n ** 18n, 175689276741650n, 0n]);
    const sellPrint = decodeSwapLog(sell, pools, price);
    expect(sellPrint?.side).toBe("sell");
    expect(sellPrint?.usd).toBeCloseTo(0.00017568927674165 * ETH_USD, 6);
    const buy = syntheticLog("v2", pool, [483057679031854n, 0n, 0n, 57n * 10n ** 18n]);
    expect(decodeSwapLog(buy, pools, price)?.side).toBe("buy");
  });

  it("usd is null when the quote cannot be priced, and no price key is emitted", () => {
    const log = syntheticLog("v4", V4_ID, [-1n, 1n, 0n, 0n, 0n, 0n]);
    const print = decodeSwapLog(log, poolsFor([v4Ref(false)]), { ...ctx, quoteUsd: () => null });
    expect(print?.side).toBe("buy");
    expect(print?.usd).toBeNull();
    expect("price" in (print ?? {})).toBe(false);
  });

  it("logKey joins tx hash and log index", () => {
    expect(logKey({ transactionHash: "0xabc", logIndex: "0x25" })).toBe("0xabc:0x25");
  });
});
