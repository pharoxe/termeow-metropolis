import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeLaunchLog, toFlowPrint, type LaunchEvent, type LaunchTradeEvent, type RawLog } from "./decode";
import {
  ADDRESSES,
  LAUNCHPADS,
  QUOTES,
  launchAddresses,
  launchTopicSet,
  padOfAddress,
  type DynamicEmitters,
  type LaunchpadId
} from "./pads";

type IndexFile = { file: string; pad: string; event: string; topic0?: string; block?: number; tx?: string };
type Index = { files: IndexFile[] };

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(`../__fixtures__/${file}`, import.meta.url), "utf8")) as T;
}

const index = loadJson<Index>("index.json");
const logFixtures = index.files.filter((entry): entry is Required<IndexFile> => typeof entry.topic0 === "string");

/** Expected kind per fixture event name; every other event (unknown-*, Sync, Transfer) must decode to null. */
const EXPECTED_KIND: Record<string, LaunchEvent["kind"]> = {
  TokenLaunched: "launch",
  TokenCreated: "launch",
  TokenCreate: "launch",
  LaunchSwept: "graduation",
  PoolGraduated: "graduation",
  CurveBuy: "trade",
  CurveSell: "trade",
  TokenBought: "trade",
  TokenSold: "trade",
  TokenPurchase: "trade",
  TokenSale: "trade",
  TokensBought: "trade",
  TokensSold: "trade"
};
const EXPECTED_SIDE: Record<string, "buy" | "sell"> = {
  CurveBuy: "buy",
  CurveSell: "sell",
  TokenBought: "buy",
  TokenSold: "sell",
  TokenPurchase: "buy",
  TokenSale: "sell",
  TokensBought: "buy",
  TokensSold: "sell"
};

function padId(fixturePad: string): LaunchpadId {
  if (fixturePad.startsWith("poolstrade")) return "pools-trade";
  return fixturePad as LaunchpadId;
}

/** The runtime emitter set as the service would build it: curves/AMMs learned from the launch fixtures. */
function buildContext(): { curveTokens: DynamicEmitters } {
  const curveTokens: DynamicEmitters = new Map();
  const empty = { curveTokens: new Map() };
  for (const file of ["pons-TokenLaunched.json", "bags-TokenCreated.json"]) {
    for (const log of loadJson<RawLog[]>(file)) {
      const event = decodeLaunchLog(log, empty);
      if (event?.kind === "launch" && event.curve) {
        curveTokens.set(event.curve, { token: event.token, launchpad: event.launchpad, quote: event.quote });
      }
    }
  }
  return { curveTokens };
}

const ctx = buildContext();
const first = (file: string): RawLog => loadJson<RawLog[]>(file)[0];

describe("pads registry", () => {
  it("lists lowercase, unique static addresses and 66-char topics", () => {
    const addresses = launchAddresses();
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const address of addresses) expect(address).toMatch(/^0x[0-9a-f]{40}$/);
    for (const pad of LAUNCHPADS) {
      for (const topic of [...pad.launchTopics, ...pad.tradeTopics, ...pad.graduationTopics]) {
        expect(topic).toMatch(/^0x[0-9a-f]{64}$/);
      }
    }
  });

  it("covers every decodable fixture topic0 and maps addresses to pads", () => {
    const topics = launchTopicSet();
    for (const entry of logFixtures) {
      if (EXPECTED_KIND[entry.event]) expect(topics.has(entry.topic0)).toBe(true);
    }
    expect(padOfAddress(ADDRESSES.ponsFactory.toUpperCase().replace("0X", "0x"))).toBe("pons");
    expect(padOfAddress(ADDRESSES.poolsTradeMetadata)).toBe("pools-trade");
    expect(padOfAddress("0x9a6d239adb8ccf1e9eb8f0722cfac6bbda410b7b")).toBeNull();
  });
});

describe("decodeLaunchLog against every captured fixture", () => {
  for (const entry of logFixtures) {
    const expected = EXPECTED_KIND[entry.event] ?? null;
    it(`${entry.file} (${entry.event}) -> ${expected ?? "null"}`, () => {
      const logs = loadJson<RawLog[]>(entry.file);
      expect(logs.length).toBeGreaterThan(0);
      for (const log of logs) {
        const event = decodeLaunchLog(log, ctx);
        if (expected === null) {
          expect(event).toBeNull();
          continue;
        }
        expect(event?.kind).toBe(expected);
        expect(event?.launchpad).toBe(padId(entry.pad));
        expect(event?.chain).toBe("robinhood");
        if (event?.kind === "trade") expect(event.side).toBe(EXPECTED_SIDE[entry.event]);
      }
      const head = decodeLaunchLog(logs[0], ctx);
      if (expected !== null) {
        expect(head?.tx).toBe(entry.tx);
        expect(head?.block).toBe(entry.block);
      }
    });
  }
});

describe("Pons", () => {
  const launch = decodeLaunchLog(first("pons-TokenLaunched.json"), ctx);
  const buy = decodeLaunchLog(first("pons-curve-CurveBuy.json"), ctx);
  const sell = decodeLaunchLog(first("pons-curve-CurveSell.json"), ctx);

  it("TokenLaunched: token/curve/deployer from topics, pairToken from data", () => {
    expect(launch).toMatchObject({
      kind: "launch",
      token: "0x90f4707151fde7b2acddc0ef68281d1bffe2e2a5",
      curve: "0x9a6d239adb8ccf1e9eb8f0722cfac6bbda410b7b",
      creator: "0xa60e892ab5fbf4754e3052b7643e48a1bd6b3065",
      quote: QUOTES.usdg,
      name: null,
      symbol: null,
      uri: null,
      pool: null
    });
  });

  it("CurveBuy: trader is the recipient (topic2), not the router (topic1); USDG quote is not wei", () => {
    expect(buy).toMatchObject({
      kind: "trade",
      side: "buy",
      token: "0x90f4707151fde7b2acddc0ef68281d1bffe2e2a5",
      curve: "0x9a6d239adb8ccf1e9eb8f0722cfac6bbda410b7b",
      trader: "0xa60e892ab5fbf4754e3052b7643e48a1bd6b3065",
      quoteAmount: 1246982306n,
      tokenAmount: 276145629319787317099859219n,
      quote: QUOTES.usdg,
      quoteWei: null
    });
  });

  it("CurveSell: tokensIn equals the launch buy's tokensOut", () => {
    expect(sell?.kind).toBe("trade");
    if (sell?.kind !== "trade" || buy?.kind !== "trade") return;
    expect(sell.side).toBe("sell");
    expect(sell.tokenAmount).toBe(buy.tokenAmount);
    expect(sell.trader).toBe("0xa60e892ab5fbf4754e3052b7643e48a1bd6b3065");
    expect(sell.quoteAmount).toBe(0x520c8de7n);
  });

  it("graduation events carry the token and no invented pool", () => {
    const swept = decodeLaunchLog(first("pons-LaunchSwept.json"), ctx);
    const graduated = decodeLaunchLog(first("pons-PoolGraduated.json"), ctx);
    const token = "0x8f5ef8c3d77c1b89fda82fc910ede9f809de524b";
    expect(swept).toMatchObject({ kind: "graduation", token, curve: null, pool: null });
    expect(graduated).toMatchObject({ kind: "graduation", token, curve: null, pool: null });
  });

  it("a curve log from an unregistered emitter is null", () => {
    expect(decodeLaunchLog(first("pons-curve-CurveBuy.json"), { curveTokens: new Map() })).toBeNull();
  });

  it("an ETH-quoted curve yields quoteWei", () => {
    const log = first("pons-curve-CurveBuy.json");
    const curveTokens: DynamicEmitters = new Map([[log.address, { token: "0xabc", launchpad: "pons", quote: QUOTES.nativeEth }]]);
    const event = decodeLaunchLog(log, { curveTokens });
    expect(event?.kind === "trade" && event.quoteWei).toBe(1246982306n);
  });
});

describe("pools.trade", () => {
  const token = "0xde2dc5775c191fb35acb2a184dba3346049b3a8a";

  it("factory TokenCreated has only the token (name/symbol need ERC20 calls)", () => {
    expect(decodeLaunchLog(first("poolstrade-TokenCreated.json"), ctx)).toMatchObject({
      kind: "launch",
      launchpad: "pools-trade",
      token,
      creator: null,
      curve: null,
      name: null,
      symbol: null,
      uri: null
    });
    expect(decodeLaunchLog(first("poolstrade-original-TokenCreated.json"), ctx)?.kind).toBe("launch");
  });

  it("metadata overload decodes the image URI from the nested tuple and never a name", () => {
    const event = decodeLaunchLog(first("poolstrade-metadata-TokenCreated.json"), ctx);
    expect(event).toMatchObject({ kind: "launch", token, name: null, symbol: null });
    expect(event?.kind === "launch" && event.uri).toBe("ipfs://bafkreibj5vpmt2nz7lyeucmea3jkhan4b7y2do4wg2qdzuehpd2cucrtuu");
  });

  it("metadata overload with a non-empty description still does not surface it as the name", () => {
    for (const log of loadJson<RawLog[]>("poolstrade-metadata-TokenCreated.json")) {
      const event = decodeLaunchLog(log, ctx);
      expect(event?.kind === "launch" && event.name).toBeNull();
      expect(event?.kind === "launch" && (event.uri === null || event.uri.startsWith("ipfs://"))).toBe(true);
    }
  });
});

describe("Flap", () => {
  const token = "0x6f487ee1f48ca43f7bfedd934f2e0a8d5fec8888";

  it("TokenCreated decodes creator, token and the ABI strings; empty CID stays null", () => {
    expect(decodeLaunchLog(first("flap-TokenCreated.json"), ctx)).toMatchObject({
      kind: "launch",
      token,
      creator: "0x0d3b8a432409bee63679b21c7705d0112f56944a",
      curve: null,
      name: "A",
      symbol: "A",
      uri: null
    });
    const withCid = loadJson<RawLog[]>("flap-TokenCreated.json").map((log) => decodeLaunchLog(log, ctx));
    expect(withCid.some((event) => event?.kind === "launch" && event.uri?.startsWith("bafkrei"))).toBe(true);
    expect(withCid.some((event) => event?.kind === "launch" && event.name === "Robin Crow" && event.symbol === "RCR")).toBe(true);
  });

  it("TokenBought uses the pseudo pair and leaves quoteWei null when the ERC20 quote is unknown", () => {
    const event = decodeLaunchLog(first("flap-TokenBought.json"), ctx);
    expect(event).toMatchObject({
      kind: "trade",
      side: "buy",
      token,
      curve: `flap:${token}`,
      trader: "0x0d3b8a432409bee63679b21c7705d0112f56944a",
      tokenAmount: 5681880443243816605047997n,
      quoteAmount: 10n ** 16n,
      quote: null,
      quoteWei: null
    });
  });

  it("TokenBought prices in wei once the service registers a WETH quote for the pseudo pair", () => {
    const curveTokens: DynamicEmitters = new Map([[`flap:${token}`, { token, launchpad: "flap", quote: QUOTES.weth }]]);
    const event = decodeLaunchLog(first("flap-TokenBought.json"), { curveTokens });
    expect(event?.kind === "trade" && event.quoteWei).toBe(10n ** 16n);
  });

  it("TokenSold: seller wallet and quote paid out", () => {
    expect(decodeLaunchLog(first("flap-TokenSold.json"), ctx)).toMatchObject({
      kind: "trade",
      side: "sell",
      token: "0xa29042272cc55fb939e0165509ee124447767777",
      trader: "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc",
      tokenAmount: 19201326496689909538528232n,
      quoteAmount: 679152801396842569n
    });
  });
});

describe("trench.today", () => {
  const token = "0x9b86fd810bbc0f8de0977838208ef4ed8437cccc";

  it("TokenCreate: creator/curve/token from topics, UTF-8 name, stock quote, ipfs URI", () => {
    const event = decodeLaunchLog(first("trench-TokenCreate.json"), ctx);
    expect(event).toMatchObject({
      kind: "launch",
      token,
      creator: "0x26d5041c9d1d4ec3d4db9a5d30e43e5df596d9c6",
      curve: "0x1a1e13654700fbc614ad2cf0a39ad698c717e96b",
      quote: "0xec262a75e413fafd0df80480274532c79d42da09",
      name: "₿itflap",
      symbol: "₿itflap"
    });
    expect(event?.kind === "launch" && event.uri).toBe("ipfs://bafkreicnvoccanw7gz5u5ydqrmmitter2zwtwofvshctn3rt4b5ott5ysq");
  });

  it("TokenPurchase / TokenSale: proxy-emitted, pseudo pair, quote never treated as wei", () => {
    const purchase = decodeLaunchLog(first("trench-TokenPurchase.json"), ctx);
    const sale = decodeLaunchLog(first("trench-TokenSale.json"), ctx);
    expect(purchase).toMatchObject({
      kind: "trade",
      side: "buy",
      token,
      curve: `trench:${token}`,
      trader: "0x26d5041c9d1d4ec3d4db9a5d30e43e5df596d9c6",
      tokenAmount: 3337570014110564240832356n,
      quoteWei: null
    });
    expect(sale).toMatchObject({ kind: "trade", side: "sell", token, trader: "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc" });
    expect(sale?.kind === "trade" && sale.tokenAmount).toBe(3337570014110564240832356n);
  });

  it("Sync is reserve telemetry, not an event", () => {
    expect(decodeLaunchLog(first("trench-Sync.json"), ctx)).toBeNull();
  });
});

describe("Bags.fm", () => {
  const token = "0x403863197e9e4a23bf3e469b04a2b8cc74cb5dc2";
  const amm = "0xc3642a85c8b1112a2ce280865b8c8c67d32db789";

  it("TokenCreated: token / AMM proxy / creator from topics, strings from data, native ETH quote", () => {
    expect(decodeLaunchLog(first("bags-TokenCreated.json"), ctx)).toMatchObject({
      kind: "launch",
      token,
      curve: amm,
      creator: "0xd193b3c9d6c581fce6b7990153c526484b981b8a",
      quote: QUOTES.nativeEth,
      name: "RobbingHood",
      symbol: "ROBBINGHOO",
      uri: "https://ipfs.io/ipfs/QmYUVPfCxZM8HfgyhP8RejxPgSsfQx7YUoVRRtHknA1FMn"
    });
  });

  it("TokensBought: router is not reported as the trader; ETH in is wei", () => {
    expect(decodeLaunchLog(first("bags-amm-TokensBought.json"), ctx)).toMatchObject({
      kind: "trade",
      side: "buy",
      token,
      curve: amm,
      trader: null,
      quoteAmount: 0x57cc3a97c0ee00n,
      quoteWei: 0x57cc3a97c0ee00n,
      tokenAmount: 0xfefc57cc549f532334079n,
      quote: QUOTES.nativeEth
    });
  });

  it("TokensSold: tokens in and gross ETH out", () => {
    expect(decodeLaunchLog(first("bags-amm-TokensSold.json"), ctx)).toMatchObject({
      kind: "trade",
      side: "sell",
      tokenAmount: 0x78ec454bb59b61b949908n,
      quoteWei: 0x2bb2216332674cn
    });
  });

  it("a non-router sender is surfaced as the trader", () => {
    const log = first("bags-amm-TokensBought.json");
    const wallet = "0x000000000000000000000000d193b3c9d6c581fce6b7990153c526484b981b8a";
    const event = decodeLaunchLog({ ...log, topics: [log.topics[0], wallet, wallet] }, ctx);
    expect(event?.kind === "trade" && event.trader).toBe("0xd193b3c9d6c581fce6b7990153c526484b981b8a");
  });
});

describe("defensive paths", () => {
  const log = first("pons-TokenLaunched.json");

  it("unknown topic on a known pad, unknown address, and missing topics are null", () => {
    expect(decodeLaunchLog({ ...log, topics: [`0x${"ab".repeat(32)}`, ...log.topics.slice(1)] }, ctx)).toBeNull();
    expect(decodeLaunchLog({ ...log, address: `0x${"cd".repeat(20)}` }, ctx)).toBeNull();
    expect(decodeLaunchLog({ ...log, topics: [] }, ctx)).toBeNull();
    expect(decodeLaunchLog({ ...log, topics: [log.topics[0]] }, ctx)).toBeNull();
  });

  it("truncated or non-hex data never throws", () => {
    expect(decodeLaunchLog({ ...log, data: "0xzz" }, ctx)).toBeNull();
    expect(decodeLaunchLog({ ...first("flap-TokenCreated.json"), data: "0x" }, ctx)).toBeNull();
    expect(decodeLaunchLog({ ...first("bags-TokenCreated.json"), data: `0x${"00".repeat(32)}` }, ctx)).toBeNull();
    expect(decodeLaunchLog({ ...log, blockNumber: "nope" }, ctx)).toBeNull();
  });

  it("string offsets pointing past the payload decode to null instead of garbage", () => {
    const flap = first("flap-TokenCreated.json");
    const words = flap.data.slice(2).match(/.{64}/g) ?? [];
    words[4] = "0".repeat(60) + "ffff";
    const event = decodeLaunchLog({ ...flap, data: `0x${words.join("")}` }, ctx);
    expect(event?.kind === "launch" && event.name).toBeNull();
    expect(event?.kind === "launch" && event.symbol).toBe("A");
  });
});

describe("toFlowPrint", () => {
  const buy = decodeLaunchLog(first("bags-amm-TokensBought.json"), ctx) as LaunchTradeEvent;
  const flap = decodeLaunchLog(first("flap-TokenBought.json"), ctx) as LaunchTradeEvent;

  it("prices ETH-quoted trades and keeps pair = curve", () => {
    const print = toFlowPrint(buy, 1_700_000_000_000, 4000);
    expect(print).toMatchObject({ chain: "robinhood", pair: buy.curve, tx: buy.tx, time: 1_700_000_000_000, side: "buy", source: "own" });
    expect(print.usd).toBeCloseTo((Number(0x57cc3a97c0ee00n) / 1e18) * 4000, 6);
  });

  it("usd is null when ethUsd is null, non-finite, or the quote is not ETH-denominated", () => {
    expect(toFlowPrint(buy, 0, null).usd).toBeNull();
    expect(toFlowPrint(buy, 0, Number.NaN).usd).toBeNull();
    expect(toFlowPrint(buy, 0, 0).usd).toBeNull();
    expect(toFlowPrint(flap, 0, 4000)).toMatchObject({ pair: `flap:${flap.token}`, usd: null });
  });
});
