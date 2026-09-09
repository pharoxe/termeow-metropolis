export type ChainId = "solana" | "robinhood";
/** Which venue produced a quote. A quote is only executable through the router that built it. */
export type RouterId = "0x" | "jupiter" | "clawpump";
export type Order = { chain?: ChainId; router?: RouterId; inputMint: string; outputMint: string; amount: string; slippageBps: number; walletAddress?: string };
const sameAddress = (a?: string, b?: string) => a?.toLowerCase() === b?.toLowerCase();
export function matchesOrder(a: Order, b: Order): boolean {
  return (a.chain ?? "solana") === (b.chain ?? "solana") && a.router === b.router
    && sameAddress(a.inputMint, b.inputMint) && sameAddress(a.outputMint, b.outputMint)
    && a.amount === b.amount && a.slippageBps === b.slippageBps && sameAddress(a.walletAddress, b.walletAddress);
}
export function matchesRoute(route: Record<string, unknown>, order: Order): boolean {
  return route.inputMint === order.inputMint && route.outputMint === order.outputMint && route.inAmount === order.amount && route.slippageBps === order.slippageBps;
}
export class QuoteCache {
  private entries = new Map<string, { expiresAt: number; quote: unknown; order: Order; router: RouterId; chain: ChainId }>();
  constructor(private readonly max = 1000, private readonly ttl = 60_000, private readonly now = Date.now) {}
  prune() { for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(id); }
  set(id: string, quote: unknown, order: Order, router: RouterId) {
    this.prune();
    this.entries.delete(id);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    const expiresAt = this.now() + this.ttl;
    this.entries.set(id, { expiresAt, quote, order: { ...order }, router, chain: order.chain ?? "solana" });
    return expiresAt;
  }
  get(id: string) { this.prune(); return this.entries.get(id); }
  delete(id: string) { this.entries.delete(id); }
  get size() { this.prune(); return this.entries.size; }
}
