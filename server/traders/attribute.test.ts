import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DOMINANCE_FACTOR,
  TRANSFER_TOPIC,
  USER_OPERATION_EVENT_TOPIC,
  ZERO_ADDRESS,
  traderFromReceipt,
  type ReceiptLike,
  type ReceiptLogLike
} from "./attribute.js";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const ENTRY_POINT = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108";
const RELAY_B = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const AVG_JOES = "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1";
const KYLE = "0x39b337121494b10cffe3e581ab3281b2d62c5b08";

type Fill = {
  file: string;
  tx: string;
  expectedWallet: string;
  side: "buy" | "sell";
  token: string;
  txTo: string;
  txFrom: string;
  allTapeFillsInTx: Array<{ wallet: string; handle: string }>;
};
type Captured = { receipt?: ReceiptLike };

/**
 * Per captured receipt: the path the wallet is expected through, the fill's token amount when it is known from an
 * independent source (the Swap log in the receipt, or the tape row's `amount`), and what the no-hint answer must be.
 * Bundled txs (Multicall3 / 0x45b62633-originated) carry several traders' fills of the same token and must answer null
 * without a hint; the fee-skim receipt 4c50db06 resolves by dominance (wallet leg 99x the 1% fee leg).
 */
const EXPECTED: Record<string, { via: "userop" | "transfer"; hint?: bigint; hintSource: string; withoutHint: "wallet" | "null" }> = {
  "0x51e1a0bc": { via: "userop", hint: 1181251181251100000000n, hintSource: "v3 Swap log amount0", withoutHint: "wallet" },
  "0xc3791de1": { via: "transfer", hint: 2088625898019576944492190n, hintSource: "v4 Swap log amount0", withoutHint: "wallet" },
  "0x4c50db06": { via: "transfer", hint: 193279093910801495838656n, hintSource: "v4 Swap log amount0 (wallet leg is 99%)", withoutHint: "wallet" },
  "0x1a408fc3": { via: "transfer", hintSource: "no Swap log; single chain", withoutHint: "wallet" },
  "0x20bd4d71": { via: "transfer", hint: 17433386586832238n, hintSource: "tape row amount 0.017433386586832238 x 1e18", withoutHint: "null" },
  "0xed063087": { via: "transfer", hint: 150088757933311270n, hintSource: "wallet's Transfer leg (no tape metadata saved)", withoutHint: "null" },
  "0x1ce1f61a": { via: "transfer", hint: 15756890766121415n, hintSource: "wallet's Transfer leg (no tape metadata saved)", withoutHint: "null" },
  "0xc13a06f4": { via: "transfer", hint: 11022648613447168n, hintSource: "wallet's Transfer leg (no tape metadata saved)", withoutHint: "null" }
};

function json<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

/** Every index.json fill whose file carries a receipt (two concurrent-writer files are tx-only). */
function capturedFills(): Array<Fill & { receipt: ReceiptLike }> {
  const { fills } = json<{ fills: Fill[] }>("index.json");
  return fills.flatMap((fill) => {
    const receipt = json<Captured>(fill.file).receipt;
    return receipt ? [{ ...fill, receipt }] : [];
  });
}

function excludeFor(fill: Fill): Set<string> {
  return new Set([ZERO_ADDRESS, ENTRY_POINT, RELAY_B, POOL_MANAGER, fill.txTo, fill.txFrom].map((address) => address.toLowerCase()));
}

function word(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function transfer(token: string, from: string, to: string, amount: bigint): ReceiptLogLike {
  return { address: token, topics: [TRANSFER_TOPIC, word(from), word(to)], data: `0x${amount.toString(16).padStart(64, "0")}` };
}

function userOp(sender: string): ReceiptLogLike {
  return { address: ENTRY_POINT, topics: [USER_OPERATION_EVENT_TOPIC, `0x${"11".repeat(32)}`, word(sender), word(ZERO_ADDRESS)], data: "0x" };
}

const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x3333333333333333333333333333333333333333";
const WALLET = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const BASE = new Set([ZERO_ADDRESS, POOL]);

describe("traderFromReceipt on the captured receipts", () => {
  const fills = capturedFills();

  it("covers every receipt fixture with an expectation", () => {
    expect(fills.length).toBe(8);
    for (const fill of fills) expect(EXPECTED[fill.tx.slice(0, 10)], fill.file).toBeDefined();
  });

  it.each(fills.map((fill) => [fill.file, fill] as const))("%s resolves to the tape wallet with the fill amount", (_file, fill) => {
    const expected = EXPECTED[fill.tx.slice(0, 10)];
    const result = traderFromReceipt(fill.receipt, { token: fill.token, side: fill.side, exclude: excludeFor(fill), amount: expected.hint });
    expect(result.address).toBe(fill.expectedWallet);
    expect(result.via).toBe(expected.via);
  });

  it.each(fills.map((fill) => [fill.file, fill] as const))("%s without an amount: single-fill relays resolve, bundles stay null", (_file, fill) => {
    const expected = EXPECTED[fill.tx.slice(0, 10)];
    const result = traderFromReceipt(fill.receipt, { token: fill.token, side: fill.side, exclude: excludeFor(fill) });
    if (expected.withoutHint === "wallet") {
      expect(result.address).toBe(fill.expectedWallet);
      expect(result.via).toBe(expected.via);
    } else {
      expect(result).toMatchObject({ address: null, via: null });
      expect(result.candidates).toBeGreaterThan(1);
    }
  });

  it("attributes each co-bundled fill of the same token to its own wallet by amount (ed063087: kyle + AvgJoesCrypto, DJT)", () => {
    const fill = fills.find((row) => row.tx.startsWith("0xed063087"))!;
    expect(fill.allTapeFillsInTx.map((row) => row.handle).sort()).toEqual(["AvgJoesCrypto", "kyle"]);
    const ctx = { token: fill.token, side: fill.side, exclude: excludeFor(fill) };
    expect(traderFromReceipt(fill.receipt, { ...ctx, amount: 150088757933311270n }).address).toBe(KYLE);
    expect(traderFromReceipt(fill.receipt, { ...ctx, amount: 142581805837310573n }).address).toBe(AVG_JOES);
    expect(traderFromReceipt(fill.receipt, ctx)).toMatchObject({ address: null, candidates: 60 });
  });

  it("multi-userop receipt (51e1a0bc): picks the sender that is also the token's Transfer counterparty", () => {
    const fill = fills.find((row) => row.tx.startsWith("0x51e1a0bc"))!;
    const ctx = { token: fill.token, side: fill.side, exclude: excludeFor(fill) };
    expect(traderFromReceipt(fill.receipt, ctx)).toEqual({ address: AVG_JOES, via: "userop", candidates: 2 });
    const withoutTransfers = { ...fill.receipt, logs: fill.receipt.logs.filter((log) => log.address.toLowerCase() !== fill.token) };
    expect(traderFromReceipt(withoutTransfers, ctx)).toEqual({ address: null, via: null, candidates: 2 });
  });

  it("sell chain without user ops resolves to the original sender (51e1a0bc minus its EntryPoint logs)", () => {
    const fill = fills.find((row) => row.tx.startsWith("0x51e1a0bc"))!;
    const stripped = { ...fill.receipt, logs: fill.receipt.logs.filter((log) => log.address.toLowerCase() !== ENTRY_POINT) };
    const result = traderFromReceipt(stripped, { token: fill.token, side: "sell", exclude: excludeFor(fill) });
    expect(result).toEqual({ address: AVG_JOES, via: "transfer", candidates: 1 });
  });

  it("the wrong side of a single chain has no candidate once the pool is excluded (c3791de1 as a sell)", () => {
    const fill = fills.find((row) => row.tx.startsWith("0xc3791de1"))!;
    const result = traderFromReceipt(fill.receipt, { token: fill.token, side: "sell", exclude: excludeFor(fill) });
    expect(result).toEqual({ address: null, via: null, candidates: 0 });
  });
});

describe("traderFromReceipt rules", () => {
  it("a single UserOperationEvent sender wins even without a Transfer", () => {
    const receipt = { logs: [userOp(WALLET)] };
    expect(traderFromReceipt(receipt, { token: TOKEN, side: "buy", exclude: BASE })).toEqual({ address: WALLET, via: "userop", candidates: 1 });
  });

  it("reduces an equal-amount hop chain to its endpoint and ignores intermediaries", () => {
    const receipt = { logs: [transfer(TOKEN, POOL, ROUTER, 100n), transfer(TOKEN, ROUTER, WALLET, 100n)] };
    expect(traderFromReceipt(receipt, { token: TOKEN, side: "buy", exclude: BASE })).toEqual({ address: WALLET, via: "transfer", candidates: 1 });
    const sell = { logs: [transfer(TOKEN, WALLET, ROUTER, 100n), transfer(TOKEN, ROUTER, POOL, 100n)] };
    expect(traderFromReceipt(sell, { token: TOKEN, side: "sell", exclude: BASE })).toEqual({ address: WALLET, via: "transfer", candidates: 1 });
  });

  it("an excluded router never becomes the trader", () => {
    const receipt = { logs: [transfer(TOKEN, POOL, ROUTER, 100n)] };
    expect(traderFromReceipt(receipt, { token: TOKEN, side: "buy", exclude: new Set([...BASE, ROUTER]) })).toEqual({ address: null, via: null, candidates: 0 });
    expect(traderFromReceipt(receipt, { token: TOKEN, side: "buy", exclude: BASE }).address).toBe(ROUTER);
  });

  it("without a hint only a dominant endpoint is attributed", () => {
    const fee = { logs: [transfer(TOKEN, POOL, OTHER, 1n), transfer(TOKEN, POOL, WALLET, DOMINANCE_FACTOR)] };
    expect(traderFromReceipt(fee, { token: TOKEN, side: "buy", exclude: BASE })).toEqual({ address: WALLET, via: "transfer", candidates: 2 });
    const bundle = { logs: [transfer(TOKEN, POOL, OTHER, 6n), transfer(TOKEN, POOL, WALLET, 10n)] };
    expect(traderFromReceipt(bundle, { token: TOKEN, side: "buy", exclude: BASE })).toEqual({ address: null, via: null, candidates: 2 });
  });

  it("a hint picks the exact leg, tolerates a 10% skim, and stays null when two legs match", () => {
    const bundle = { logs: [transfer(TOKEN, POOL, OTHER, 6n), transfer(TOKEN, POOL, WALLET, 10n)] };
    const ctx = { token: TOKEN, side: "buy" as const, exclude: BASE };
    expect(traderFromReceipt(bundle, { ...ctx, amount: 10n }).address).toBe(WALLET);
    expect(traderFromReceipt(bundle, { ...ctx, amount: 6n }).address).toBe(OTHER);
    expect(traderFromReceipt({ logs: [transfer(TOKEN, POOL, OTHER, 500n), transfer(TOKEN, POOL, WALLET, 990n)] }, { ...ctx, amount: 1000n }).address).toBe(WALLET);
    const twins = { logs: [transfer(TOKEN, POOL, OTHER, 10n), transfer(TOKEN, POOL, WALLET, 10n)] };
    expect(traderFromReceipt(twins, { ...ctx, amount: 10n })).toEqual({ address: null, via: null, candidates: 2 });
    const single = { logs: [transfer(TOKEN, POOL, WALLET, 10n)] };
    expect(traderFromReceipt(single, { ...ctx, amount: 999n }).address).toBe(WALLET);
  });

  it("answers null with zero candidates when nothing qualifies and skips malformed or foreign logs", () => {
    const ctx = { token: TOKEN, side: "buy" as const, exclude: BASE };
    expect(traderFromReceipt({ logs: [] }, ctx)).toEqual({ address: null, via: null, candidates: 0 });
    const junk: ReceiptLike = {
      logs: [
        { address: TOKEN, topics: [TRANSFER_TOPIC], data: "0x" },
        { address: TOKEN, topics: [TRANSFER_TOPIC, word(POOL), word(WALLET)], data: "0x" },
        transfer(OTHER, POOL, WALLET, 10n),
        transfer(TOKEN, POOL, ZERO_ADDRESS, 10n)
      ]
    };
    expect(traderFromReceipt(junk, ctx)).toEqual({ address: null, via: null, candidates: 0 });
    expect(traderFromReceipt({ logs: [transfer(TOKEN, POOL, WALLET, 10n)] }, { ...ctx, token: TOKEN.toUpperCase() }).address).toBe(WALLET);
  });
});
