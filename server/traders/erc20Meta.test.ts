import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EvmRpcError } from "../tape/robinhood/rpc.js";
import { UpstreamError } from "../lib/http.js";
import { DECIMALS_SELECTOR, Erc20Meta, SYMBOL_SELECTOR, decodeAbiString, decodeAbiUint8, type Erc20MetaRpc } from "./erc20Meta.js";

type Probe = { method: string; result?: unknown; ok?: boolean };
type Batch = { label?: string; requests?: Probe[]; replies?: unknown; results?: unknown };

const NOW = 1_800_000_000_000;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

function abiString(text: string): string {
  const hex = Buffer.from(text, "utf8").toString("hex");
  return `0x${(32).toString(16).padStart(64, "0")}${(hex.length / 2).toString(16).padStart(64, "0")}${hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")}`;
}

function word(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** Answers decimals/symbol per token from a table; records calls and priorities. */
function fakeRpc(table: Record<string, { decimals?: number | Error; symbol?: string | Error }>): Erc20MetaRpc & { calls: Array<[string, string, string | undefined]> } {
  const calls: Array<[string, string, string | undefined]> = [];
  return {
    calls,
    async call(_method, params, priority) {
      const [{ to, data }] = params as [{ to: string; data: string }];
      calls.push([to, data, priority]);
      const row = table[to] ?? {};
      const value = data === DECIMALS_SELECTOR ? row.decimals : data === SYMBOL_SELECTOR ? row.symbol : undefined;
      if (value instanceof Error) throw value;
      if (value === undefined) throw new EvmRpcError("eth_call: execution reverted", 3, undefined);
      return typeof value === "number" ? word(value) : abiString(value);
    }
  };
}

describe("ABI decoders", () => {
  it("decodes uint8 words and rejects empty or oversized values", () => {
    expect(decodeAbiUint8(word(18))).toBe(18);
    expect(decodeAbiUint8(word(6))).toBe(6);
    expect(decodeAbiUint8("0x")).toBeNull();
    expect(decodeAbiUint8(word(256))).toBeNull();
  });

  it("decodes dynamic strings, bytes32 symbols and rejects garbage", () => {
    expect(decodeAbiString(abiString("SPDR Gold Trust • Robinhood Token"))).toBe("SPDR Gold Trust • Robinhood Token");
    expect(decodeAbiString(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`)).toBe("MKR");
    expect(decodeAbiString("0x")).toBeNull();
    expect(decodeAbiString(`0x${"ff".repeat(32)}`)).toBeNull();
    expect(decodeAbiString(abiString(""))).toBeNull();
  });

  it("round-trips the 50 tokens captured by eth_call decimals()/symbol() on 2026-09-06", () => {
    const capture = JSON.parse(readFileSync(new URL("./__fixtures__/r4/getlogs-cost.json", import.meta.url), "utf8")) as { tokenMeta: Array<{ token: string; decimals: number; symbol: string }>; probes?: Batch[] };
    expect(capture.tokenMeta).toHaveLength(50);
    for (const row of capture.tokenMeta) {
      expect(decodeAbiUint8(word(row.decimals))).toBe(row.decimals);
      expect(decodeAbiString(abiString(row.symbol))).toBe(row.symbol);
    }
  });
});

describe("Erc20Meta", () => {
  const TOKEN = "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e";

  it("answers null until resolved, then caches decimals/symbol read on the low lane (two eth_calls per token)", async () => {
    const rpc = fakeRpc({ [TOKEN]: { decimals: 18, symbol: "GLD" } });
    const meta = new Erc20Meta({ rpc, now: () => NOW });
    expect(meta.get(TOKEN)).toBeNull();
    const [a, b] = await Promise.all([meta.resolve(TOKEN), meta.resolve(TOKEN.toUpperCase())]);
    expect(a).toEqual({ decimals: 18, symbol: "GLD", resolvedAt: NOW });
    expect(b).toBe(a);
    expect(rpc.calls).toHaveLength(2);
    expect(rpc.calls.every(([, , priority]) => priority === "low")).toBe(true);
    expect(meta.get(TOKEN)?.symbol).toBe("GLD");
    await meta.resolve(TOKEN);
    expect(rpc.calls).toHaveLength(2);
    expect(meta.stats()).toMatchObject({ cached: 1, pending: 0, resolved: 1, failed: 0, lastError: null, rpc: null });
  });

  it("keeps a reverting view null, marks a failed token for retry after the cooldown and never throws", async () => {
    const rpc = fakeRpc({ [TOKEN]: { decimals: 6 }, [USDG]: { decimals: new UpstreamError("upstream returned 429", 429) } });
    let now = NOW;
    const meta = new Erc20Meta({ rpc, now: () => now, retryMs: 1_000 });
    expect(await meta.resolve(TOKEN)).toMatchObject({ decimals: 6, symbol: null });
    expect(await meta.resolve(USDG)).toBeNull();
    expect(meta.stats()).toMatchObject({ failed: 1, lastError: `${USDG}: upstream returned 429` });
    const callsAfterFailure = rpc.calls.length;
    expect(await meta.resolve(USDG)).toBeNull();
    expect(rpc.calls).toHaveLength(callsAfterFailure);
    now += 1_001;
    await meta.resolve(USDG);
    expect(rpc.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(await meta.resolve("not-an-address")).toBeNull();
  });
});
