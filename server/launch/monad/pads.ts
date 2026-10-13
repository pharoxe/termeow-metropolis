import { MONAD_MAINNET, NATIVE_MON } from "../../../shared/chains.js";
import { AUSD_ADDRESS, USDC_ADDRESS, WMON_ADDRESS } from "../../tape/monad/price.js";

/**
 * Monad launchpad registry. nad.fun is the launchpad that matters on Monad: one static BondingCurve contract emits every
 * create / buy / sell / graduate event for every token (github.com/Naddotfun/contract-v3-abi IBondingCurve.json). Topic0
 * values are keccak256 of the ABI signatures and were recomputed locally; layouts live in decode.ts.
 * Addresses are lowercase so log.address can be matched after a single toLowerCase().
 */
export type LaunchpadId = "nadfun";

export type Launchpad = {
  id: LaunchpadId;
  label: string;
  /** Static contracts whose logs the service subscribes to by address. */
  addresses: string[];
  launchTopics: string[];
  tradeTopics: string[];
  graduationTopics: string[];
};

/**
 * Pads with one contract per token register it here when the launch event names it so trade logs can be attributed.
 * nad.fun trades come from the shared curve and name the token in topic2, so its emitters are pseudo keys
 * "nadfun:<token>" used only to carry the launch quote.
 */
export type DynamicEmitter = { token: string; launchpad: LaunchpadId; quote?: string | null };
export type DynamicEmitters = Map<string, DynamicEmitter>;

const NADFUN = MONAD_MAINNET.nadfun!;

export const ADDRESSES = {
  /** BondingCurve: emits CurveCreate / CurveBuy / CurveSell / CurveGraduate for every nad.fun token. */
  nadfunCurve: NADFUN.curve,
  nadfunCurveRouter: NADFUN.curveRouter,
  nadfunDexRouter: NADFUN.dexRouter,
  nadfunLens: NADFUN.lens,
  /** Graduated tokens move to a Uniswap-v3-style pool created by this factory. */
  nadfunV3Factory: NADFUN.v3Factory
} as const;

/** Quote assets seen on Monad. nad.fun curves are priced in native MON (18 decimals). */
export const QUOTES = {
  nativeMon: NATIVE_MON,
  wmon: WMON_ADDRESS,
  usdc: USDC_ADDRESS,
  ausd: AUSD_ADDRESS
} as const;

export const NADFUN_TOPICS = {
  /** CurveCreate(address indexed creator, address indexed token, address indexed pool, string name, string symbol, string tokenURI, uint256 virtualMon, uint256 virtualToken, uint256 targetTokenAmount) */
  CurveCreate: "0xd37e3f4f651fe74251701614dbeac478f5a0d29068e87bbe44e5026d166abca9",
  /** CurveBuy(address indexed sender, address indexed token, uint256 amountIn, uint256 amountOut): amountIn MON, amountOut tokens. */
  CurveBuy: "0x00a7ba871905cb955432583640b5c9fc6bdd27d36884ab2b5420839224638862",
  /** CurveSell(address indexed sender, address indexed token, uint256 amountIn, uint256 amountOut): amountIn tokens, amountOut MON. */
  CurveSell: "0x0eb25df0e2137de8ce042eeaf39080d25f0c8d451372c99db69a4c0a298d0fa1",
  /** CurveGraduate(address indexed token, address indexed pool) */
  CurveGraduate: "0xa1cae252e597e19f398a442722a17a17e62d17f9d4f3656786e18aabcd428908",
  /** CurveSync(address indexed token, uint256 realMon, uint256 realToken, uint256 virtualMon, uint256 virtualToken): reserves only, decoded to null. */
  CurveSync: "0xfd4bb47bd45abdbdb2ecd61052c9571773f9cde876e2a7745f488c20b30ab10a"
} as const;

export const LAUNCHPADS: readonly Launchpad[] = [
  {
    id: "nadfun",
    label: "nad.fun",
    addresses: [ADDRESSES.nadfunCurve],
    launchTopics: [NADFUN_TOPICS.CurveCreate],
    tradeTopics: [NADFUN_TOPICS.CurveBuy, NADFUN_TOPICS.CurveSell],
    graduationTopics: [NADFUN_TOPICS.CurveGraduate]
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

/** The pad that owns a static contract address (any case), or null for strangers. */
export function padOfAddress(address: string): LaunchpadId | null {
  return PAD_BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

/** nad.fun token page, for link-outs from launch rows. */
export function nadfunTokenUrl(token: string): string {
  return `https://nad.fun/tokens/${token}`;
}
