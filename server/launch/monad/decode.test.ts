import { describe, expect, it } from "vitest";
import { decodeLaunchLog, nadfunCurveKey, toFlowPrint, type LaunchTradeEvent, type RawLog } from "./decode";
import { ADDRESSES, LAUNCHPADS, NADFUN_TOPICS, QUOTES, launchAddresses, launchTopicSet, nadfunTokenUrl, padOfAddress, type DynamicEmitters } from "./pads";

/** Synthetic nad.fun BondingCurve logs built from the published ABI layouts (contract-v3-abi IBondingCurve.json). */
const CREATOR = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const TRADER = "0x4444444444444444444444444444444444444444";
const EMPTY: DynamicEmitters = new Map();

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const topic = (address: string) => `0x${pad(address)}`;
const uint = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
function abiStrings(values: string[], tail: Array<bigint | number>): string {
  const heads: string[] = [];
  const bodies: string[] = [];
  let offset = (values.length + tail.length) * 32;
  for (const value of values) {
    const hex = Buffer.from(value, "utf8").toString("hex");
    const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
    heads.push(uint(offset));
    bodies.push(uint(value.length) + padded);
    offset += 32 + padded.length / 2;
  }
  return `0x${heads.join("")}${tail.map(uint).join("")}${bodies.join("")}`;
}

function log(topics: string[], data: string, address = ADDRESSES.nadfunCurve): RawLog {
  return { address, topics, data, transactionHash: "0xabc", blockNumber: "0x10", logIndex: "0x2" };
}

const create = () => log([NADFUN_TOPICS.CurveCreate, topic(CREATOR), topic(TOKEN), topic(POOL)], abiStrings(["Meow Coin", "MEOW", "ipfs://meow"], [1n, 2n, 3n]));
const buy = () => log([NADFUN_TOPICS.CurveBuy, topic(TRADER), topic(TOKEN)], `0x${uint(2n * 10n ** 18n)}${uint(5_000n * 10n ** 18n)}`);
const sell = () => log([NADFUN_TOPICS.CurveSell, topic(TRADER), topic(TOKEN)], `0x${uint(1_000n * 10n ** 18n)}${uint(10n ** 17n)}`);

describe("nad.fun pad registry", () => {
  it("subscribes to the single shared BondingCurve and knows its four event topics", () => {
    expect(LAUNCHPADS.map((p) => p.id)).toEqual(["nadfun"]);
    expect(launchAddresses()).toEqual([ADDRESSES.nadfunCurve]);
    expect(padOfAddress(ADDRESSES.nadfunCurve.toUpperCase().replace("0X", "0x"))).toBe("nadfun");
    expect(padOfAddress(POOL)).toBeNull();
    expect(launchTopicSet()).toEqual(new Set([NADFUN_TOPICS.CurveCreate, NADFUN_TOPICS.CurveBuy, NADFUN_TOPICS.CurveSell, NADFUN_TOPICS.CurveGraduate]));
    expect(nadfunTokenUrl(TOKEN)).toBe(`https://nad.fun/tokens/${TOKEN}`);
  });
});

describe("decodeLaunchLog", () => {
  it("decodes CurveCreate into a launch with creator, pool, MON quote and the ABI strings", () => {
    expect(decodeLaunchLog(create(), { curveTokens: EMPTY })).toEqual({
      chain: "monad", launchpad: "nadfun", tx: "0xabc", block: 16, logIndex: 2, kind: "launch",
      token: TOKEN, creator: CREATOR, curve: nadfunCurveKey(TOKEN), pool: POOL, quote: QUOTES.nativeMon,
      name: "Meow Coin", symbol: "MEOW", uri: "ipfs://meow"
    });
  });

  it("decodes CurveBuy (MON in, tokens out) and CurveSell (tokens in, MON out) with the MON leg as quoteWei", () => {
    expect(decodeLaunchLog(buy(), { curveTokens: EMPTY })).toMatchObject({
      kind: "trade", side: "buy", token: TOKEN, curve: `nadfun:${TOKEN}`, trader: TRADER,
      tokenAmount: 5_000n * 10n ** 18n, quoteAmount: 2n * 10n ** 18n, quote: QUOTES.nativeMon, quoteWei: 2n * 10n ** 18n
    });
    expect(decodeLaunchLog(sell(), { curveTokens: EMPTY })).toMatchObject({ side: "sell", tokenAmount: 1_000n * 10n ** 18n, quoteAmount: 10n ** 17n, quoteWei: 10n ** 17n });
  });

  it("keeps a non-MON launch quote un-denominated", () => {
    const curveTokens: DynamicEmitters = new Map([[nadfunCurveKey(TOKEN), { token: TOKEN, launchpad: "nadfun", quote: QUOTES.usdc }]]);
    expect(decodeLaunchLog(buy(), { curveTokens })).toMatchObject({ quote: QUOTES.usdc, quoteWei: null });
  });

  it("decodes CurveGraduate into the graduation pool", () => {
    const graduate = log([NADFUN_TOPICS.CurveGraduate, topic(TOKEN), topic(POOL)], "0x");
    expect(decodeLaunchLog(graduate, { curveTokens: EMPTY })).toMatchObject({ kind: "graduation", token: TOKEN, curve: nadfunCurveKey(TOKEN), pool: POOL });
  });

  it("returns null for CurveSync, strangers, other contracts and malformed data", () => {
    expect(decodeLaunchLog(log([NADFUN_TOPICS.CurveSync, topic(TOKEN)], `0x${uint(1)}${uint(2)}${uint(3)}${uint(4)}`), { curveTokens: EMPTY })).toBeNull();
    expect(decodeLaunchLog(log([`0x${"ab".repeat(32)}`], "0x"), { curveTokens: EMPTY })).toBeNull();
    expect(decodeLaunchLog({ ...buy(), address: POOL }, { curveTokens: EMPTY })).toBeNull();
    expect(decodeLaunchLog({ ...buy(), data: "0x123" }, { curveTokens: EMPTY })).toBeNull();
    expect(decodeLaunchLog({ ...buy(), data: `0x${uint(1)}` }, { curveTokens: EMPTY })).toBeNull();
  });
});

describe("toFlowPrint", () => {
  it("prices the MON leg in usd on the curve pseudo-pair, and leaves usd null without a MON price", () => {
    const event = decodeLaunchLog(buy(), { curveTokens: EMPTY }) as LaunchTradeEvent;
    expect(toFlowPrint(event, 1_000, 3.5)).toEqual({ chain: "monad", pair: `nadfun:${TOKEN}`, tx: "0xabc", time: 1_000, side: "buy", usd: 7, source: "own" });
    expect(toFlowPrint(event, 1_000, null).usd).toBeNull();
    expect(toFlowPrint({ ...event, quoteWei: null }, 1_000, 3.5).usd).toBeNull();
  });
});
