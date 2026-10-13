import type { TraderKind } from "../../shared/wire.js";
import { isAddress } from "../tape/monad/rpc.js";

/**
 * Wallet -> "smart" | "other" for Monad. A wallet is "smart" when the label book tracks it: Nansen labelled it in a
 * smart-money cohort on Monad, or the user armed an automation on it (watchlist). No RPC is spent on classification,
 * so per-print attribution never queues behind it; an untracked wallet answers "other" and is re-checked on the next
 * print because the book may learn it later (Nansen refresh, a new watch).
 */
export type TrackedLookup = { isTracked(address: string): boolean };

export type SmartClassifierStats = { smart: number; other: number; failures: number; lastError: string | null };

export class SmartWalletClassifier {
  private counters = { smart: 0, other: 0, failures: 0 };
  private lastError: string | null = null;

  constructor(private readonly book: TrackedLookup) {}

  classify(address: string, _opts: { priority?: "high" | "low" } = {}): Promise<TraderKind | null> {
    const key = address.trim().toLowerCase();
    if (!isAddress(key)) {
      this.counters.failures += 1;
      this.lastError = `invalid address ${address}`;
      return Promise.resolve(null);
    }
    const kind: TraderKind = this.book.isTracked(key) ? "smart" : "other";
    this.counters[kind === "smart" ? "smart" : "other"] += 1;
    return Promise.resolve(kind);
  }

  async classifyMany(addresses: string[]): Promise<Map<string, TraderKind | null>> {
    const distinct = [...new Set(addresses.map((address) => address.trim().toLowerCase()))];
    return new Map(await Promise.all(distinct.map(async (address): Promise<[string, TraderKind | null]> => [address, await this.classify(address)])));
  }

  /** "smart" for a tracked wallet, undefined otherwise, so callers treat untracked wallets as never classified. */
  peek(address: string): TraderKind | undefined {
    return this.book.isTracked(address) ? "smart" : undefined;
  }

  stats(): SmartClassifierStats {
    return { ...this.counters, lastError: this.lastError };
  }
}
