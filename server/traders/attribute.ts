import type { Side } from "../../shared/wire.js";

/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value). */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** ERC-4337 UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, ...). */
export const USER_OPERATION_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/**
 * Without an amount hint the largest endpoint transfer is attributed only when it exceeds every other endpoint by this
 * factor. Measured on the captured receipts (2026-09-06): the router's fee skim is 1% of the fill (receipt 4c50db06,
 * 99x), while other traders' fills bundled into the same tx sit at 1.0-4.3x (receipts ed063087, c13a06f4, 1ce1f61a,
 * 20bd4d71) and must stay unattributed.
 */
export const DOMINANCE_FACTOR = 10n;
/** An amount hint (the Swap log's token amount) matches an endpoint within 10%: the wallet leg is the swap output minus the 1% skim. */
export const HINT_TOLERANCE_PER_MILLE = 100n;

export type ReceiptLogLike = { address: string; topics: string[]; data: string };
export type ReceiptLike = { logs: ReceiptLogLike[]; to?: string | null };

export type AttributionContext = {
  /** The traded ERC-20 (any case). */
  token: string;
  side: Side;
  /** Addresses that can never be the trader: pool, router, PoolManager, EntryPoint, relay, zero. Lowercase. */
  exclude: Set<string>;
  /** Token base units of this fill (the decoded Swap leg) when known; disambiguates bundled multi-trader txs. */
  amount?: bigint;
};

export type AttributionVia = "userop" | "transfer";

export type Attribution = {
  address: string | null;
  via: AttributionVia | null;
  /** Endpoint wallets that were in contention; > 1 with a null address means the tx bundled several traders' fills. */
  candidates: number;
};

type Transfer = { from: string; to: string; amount: bigint; index: number };

const WORD_HEX = /^0x[0-9a-fA-F]{64}$/;

function topicAddress(topic: unknown): string | null {
  return typeof topic === "string" && WORD_HEX.test(topic) ? `0x${topic.slice(-40).toLowerCase()}` : null;
}

function amountOf(data: unknown): bigint | null {
  if (typeof data !== "string" || !WORD_HEX.test(data)) return null;
  return BigInt(data);
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function counterparty(transfer: Transfer, side: Side): string {
  return side === "buy" ? transfer.to : transfer.from;
}

function tokenTransfers(receipt: ReceiptLike, token: string): Transfer[] {
  const out: Transfer[] = [];
  receipt.logs.forEach((log, index) => {
    if (lower(log.address) !== token || lower(log.topics?.[0]) !== TRANSFER_TOPIC) return;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    const amount = amountOf(log.data);
    if (from === null || to === null || amount === null) return;
    out.push({ from, to, amount, index });
  });
  return out;
}

function userOpSenders(receipt: ReceiptLike): string[] {
  const senders = new Set<string>();
  for (const log of receipt.logs) {
    if (lower(log.topics?.[0]) !== USER_OPERATION_EVENT_TOPIC) continue;
    const sender = topicAddress(log.topics[2]);
    if (sender !== null) senders.add(sender);
  }
  return [...senders];
}

/**
 * Relay paths forward the token through 3-4 equal-amount hops (pool -> router -> ... -> wallet). An endpoint is a
 * buy recipient that never re-sends the same amount later, or a sell sender that never received it earlier.
 */
function endpoints(transfers: Transfer[], side: Side): Transfer[] {
  return transfers.filter((transfer) =>
    side === "buy"
      ? !transfers.some((other) => other.index > transfer.index && other.from === transfer.to && other.amount === transfer.amount)
      : !transfers.some((other) => other.index < transfer.index && other.to === transfer.from && other.amount === transfer.amount)
  );
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** Exactly one exact match wins; else exactly one endpoint within the tolerance; else null (ambiguous or absent). */
function pickByHint(candidates: Transfer[], hint: bigint): Transfer | null {
  const exact = candidates.filter((transfer) => transfer.amount === hint);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : null;
  const close = candidates.filter((transfer) => absDiff(transfer.amount, hint) * 1000n <= hint * HINT_TOLERANCE_PER_MILLE);
  return close.length === 1 ? close[0] : null;
}

/** The largest endpoint, only when it dominates the runner-up by DOMINANCE_FACTOR (fee skim, not a co-bundled fill). */
function pickDominant(candidates: Transfer[]): Transfer | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  if (sorted.length === 1) return sorted[0];
  return sorted[0].amount >= sorted[1].amount * DOMINANCE_FACTOR ? sorted[0] : null;
}

function fromUserOps(senders: string[], transfers: Transfer[], side: Side): Attribution {
  if (senders.length === 1) return { address: senders[0], via: "userop", candidates: 1 };
  const matched = senders.filter((sender) => transfers.some((transfer) => counterparty(transfer, side) === sender));
  if (matched.length === 1) return { address: matched[0], via: "userop", candidates: senders.length };
  return { address: null, via: null, candidates: matched.length || senders.length };
}

/**
 * The trader wallet behind one fill in a receipt. Every fomo.family fill is relayed (tx.from is a bundler), so the
 * wallet is read from the receipt itself: UserOperationEvent.sender when the tx went through the EntryPoint (relay A;
 * several ops => the sender that is also a Transfer counterparty of the token, else null), otherwise the endpoint of
 * the traded token's Transfer chain on the fill's side (buy => final recipient, sell => original sender), never an
 * excluded address. Bundled txs carry 2-5 traders' fills of the same token: pass `amount` to pick the matching leg;
 * without it only a dominant endpoint (>= 10x the runner-up) is attributed and the rest answer null. Pure.
 */
export function traderFromReceipt(receipt: ReceiptLike, ctx: AttributionContext): Attribution {
  const token = ctx.token.trim().toLowerCase();
  const transfers = tokenTransfers(receipt, token);
  const senders = userOpSenders(receipt).filter((sender) => !ctx.exclude.has(sender) && sender !== ZERO_ADDRESS);
  if (senders.length > 0) return fromUserOps(senders, transfers, ctx.side);
  const candidates = endpoints(transfers, ctx.side).filter((transfer) => {
    const wallet = counterparty(transfer, ctx.side);
    return wallet !== ZERO_ADDRESS && !ctx.exclude.has(wallet);
  });
  const pick =
    ctx.amount === undefined
      ? pickDominant(candidates)
      : (pickByHint(candidates, ctx.amount) ?? (candidates.length === 1 ? candidates[0] : null));
  return { address: pick ? counterparty(pick, ctx.side) : null, via: pick ? "transfer" : null, candidates: candidates.length };
}
