import { NATIVE_ETH } from "../../tape/robinhood/pools.js";
import { USDG_ADDRESS } from "../../tape/robinhood/price.js";

/**
 * Robinhood Chain (4663) launchpad registry. Every topic0 below was verified against real logs captured
 * 2026-09-06 (server/launch/__fixtures__/index.json, blocks 56027397–56057396); layouts live in decode.ts.
 * Addresses are lowercase so log.address can be matched after a single toLowerCase().
 */
export type LaunchpadId = "pons" | "pools-trade" | "flap" | "trench" | "bags";

export type Launchpad = {
  id: LaunchpadId;
  label: string;
  /** Static contracts whose logs the service subscribes to by address. */
  addresses: string[];
  launchTopics: string[];
  /** Empty when the pad's trades are not emitted by a launchpad contract (see per-pad comment). */
  tradeTopics: string[];
  /** Empty when no graduation was observed in the capture, so no layout could be verified. */
  graduationTopics: string[];
};

/**
 * Pons curves and Bags AMMs are one contract per token; the service learns them from the launch event
 * (Pons TokenLaunched topic2, Bags TokenCreated topic2) and registers them here so trade logs can be attributed.
 * Router-emitted pads (Flap, Trench) may register the pseudo key "<pad>:<token>" purely to supply `quote`.
 */
export type DynamicEmitter = { token: string; launchpad: LaunchpadId; quote?: string | null };
export type DynamicEmitters = Map<string, DynamicEmitter>;

export const ADDRESSES = {
  ponsFactory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
  /** Pons UI router: CurveBuy topic1 is this address when bought via the UI; topic2 is the wallet. */
  ponsRouter: "0xe33e9e479df8802cb0866d5d05258bec4cf62948",
  poolsTradeCurrent: "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  poolsTradeOriginal: "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
  poolsTradeMetadata: "0x000000e200088d55c39a11f609e5f667729ad49b",
  flapRouter: "0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09",
  trenchProxy: "0x77dc6f6361b7b99456fc3761ce5b7dda80d83f9d",
  bagsFactory: "0xe8cc4431adf8b5a847c113ef0c6af9043219cb37",
  /** Bags trade router: TokensBought/TokensSold topic1 == topic2 == this address in every sample (wallet not in the log). */
  bagsRouter: "0x39b38686a19836ac10162c490e4558e120cbbe5f"
} as const;

/** Quote assets seen on the pads. Only NATIVE_ETH and WETH are ETH-denominated (18 dec, priceable by ethUsd). */
export const QUOTES = {
  nativeEth: NATIVE_ETH,
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  usdg: USDG_ADDRESS,
  hoodon: "0xfb5b5778d45ae47f15323fb59b666c655174a79c"
} as const;

export const PONS_TOPICS = {
  TokenLaunched: "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
  LaunchSwept: "0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4",
  PoolGraduated: "0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259",
  /** Emitted by the per-token curve (TokenLaunched topic2), not the factory. */
  CurveBuy: "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
  CurveSell: "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df"
} as const;

export const POOLS_TRADE_TOPICS = {
  /** Same topic0 on the current and original factory; topic1 token, no data (name/symbol need ERC20 calls). */
  TokenCreated: "0x2e2b3f61b70d2d131b2a807371103cc98d51adcaa5e9a8f9c32658ad8426e74e",
  /** Metadata factory overload: description / link / image URI / socials JSON — no name or symbol. */
  MetadataTokenCreated: "0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4"
} as const;

export const FLAP_TOPICS = {
  TokenCreated: "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603",
  TokenBought: "0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7",
  TokenSold: "0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a"
} as const;

export const TRENCH_TOPICS = {
  TokenCreate: "0xe2eb7016a2fc7f0aec441cc8bc9a7ecd75d29d94478782bab1cfa9c5b0dbdf1b",
  TokenPurchase: "0xb284604a447841f5b5ee1495033bc7db1ab2f84c2624a7b7a3e9f014f32e8e7b",
  TokenSale: "0xfe41490121bfbd4555a4f9aabe1e789de1641611b7edd2a0dc1c594f684ba193",
  /** Reserve snapshot after each trade; not a launch/trade/graduation, decoded to null. */
  Sync: "0x27efe2fec96cb0ff68b9206e3dca402a919bb7172e2f2d12d49b633df3eabc4f"
} as const;

export const BAGS_TOPICS = {
  TokenCreated: "0x643b3b606052cbadac2f906ad0b462da99eda2a1d4f824d315d7f6edd3e4cced",
  /** Emitted by the per-token AMM proxy (TokenCreated topic2), not the factory. */
  TokensBought: "0x6d9c6fad0db13f6f7fca7124777996deaeb1949d0750a4874c18611ff5d436b9",
  TokensSold: "0x813ea2e4b7710a4562c34494d61d6e80fd2ba5105790f740fdcbf64f8b05b80d"
} as const;

export const LAUNCHPADS: readonly Launchpad[] = [
  {
    id: "pons",
    label: "Pons",
    addresses: [ADDRESSES.ponsFactory],
    launchTopics: [PONS_TOPICS.TokenLaunched],
    // Trades come from the dynamic per-token curve set, never from the factory address.
    tradeTopics: [PONS_TOPICS.CurveBuy, PONS_TOPICS.CurveSell],
    graduationTopics: [PONS_TOPICS.LaunchSwept, PONS_TOPICS.PoolGraduated]
  },
  {
    id: "pools-trade",
    label: "pools.trade",
    addresses: [ADDRESSES.poolsTradeCurrent, ADDRESSES.poolsTradeOriginal, ADDRESSES.poolsTradeMetadata],
    launchTopics: [POOLS_TRADE_TOPICS.TokenCreated, POOLS_TRADE_TOPICS.MetadataTokenCreated],
    // Each launch is a real Uniswap v4 pool: trades are PoolManager Swap logs owned by server/tape/robinhood.
    tradeTopics: [],
    // No curve, so nothing graduates.
    graduationTopics: []
  },
  {
    id: "flap",
    label: "Flap.sh",
    addresses: [ADDRESSES.flapRouter],
    launchTopics: [FLAP_TOPICS.TokenCreated],
    tradeTopics: [FLAP_TOPICS.TokenBought, FLAP_TOPICS.TokenSold],
    // LaunchedToDEX was not observed in the capture window; its topic0/layout is unverified, so it is left out.
    graduationTopics: []
  },
  {
    id: "trench",
    label: "trench.today",
    addresses: [ADDRESSES.trenchProxy],
    launchTopics: [TRENCH_TOPICS.TokenCreate],
    tradeTopics: [TRENCH_TOPICS.TokenPurchase, TRENCH_TOPICS.TokenSale],
    // No graduation event observed or documented; the graduation target is not in any event either.
    graduationTopics: []
  },
  {
    id: "bags",
    label: "Bags.fm",
    addresses: [ADDRESSES.bagsFactory],
    launchTopics: [BAGS_TOPICS.TokenCreated],
    // Trades come from the dynamic per-token AMM proxy set, never from the factory address.
    tradeTopics: [BAGS_TOPICS.TokensBought, BAGS_TOPICS.TokensSold],
    // No Bags graduation observed in the window; layout unverified.
    graduationTopics: []
  }
];

const PAD_BY_ADDRESS = new Map<string, LaunchpadId>(
  LAUNCHPADS.flatMap((pad) => pad.addresses.map((address) => [address, pad.id] as const))
);

/** Every static launchpad contract, lowercase, deduped — the eth_getLogs address filter. */
export function launchAddresses(): string[] {
  return [...PAD_BY_ADDRESS.keys()];
}

/** Every topic0 the decoder understands (launch, trade and graduation), lowercase. */
export function launchTopicSet(): Set<string> {
  return new Set(LAUNCHPADS.flatMap((pad) => [...pad.launchTopics, ...pad.tradeTopics, ...pad.graduationTopics]));
}

/** The pad that owns a static contract address (any case), or null for curves, AMMs and strangers. */
export function padOfAddress(address: string): LaunchpadId | null {
  return PAD_BY_ADDRESS.get(address.toLowerCase()) ?? null;
}
