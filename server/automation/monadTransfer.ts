export type MonTransferDenomination = "usd" | "mon";

const ZERO = "0x0000000000000000000000000000000000000000";
/** Display precision for quoted MON; the wei amount is what the wallet signs. */
const MON_DISPLAY_DECIMALS = 9;

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

/** A Monad recipient: a 20-byte hex address that is not the zero/burn address. Returned lowercase. */
export function validateMonadRecipient(raw: string) {
  const recipient = raw.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) throw badRequest("Invalid Monad recipient address.");
  if (recipient.toLowerCase() === ZERO || /^0x0{36}dead$/i.test(recipient)) throw badRequest("Recipient is a burn address.");
  return recipient.toLowerCase();
}

/** Exact native-MON quote for a one-time user-signed transfer, from a USD or MON amount. */
export function computeMonTransferQuote(input: { recipient: string; amount: number; denomination: MonTransferDenomination; priceUsd: number; quotedAt?: number }) {
  const recipient = validateMonadRecipient(input.recipient);
  if (!Number.isFinite(input.priceUsd) || input.priceUsd <= 0) throw new Error("MON/USD price is unavailable.");
  const maximum = input.denomination === "usd" ? 10_000 : 1_000_000;
  const minimum = input.denomination === "usd" ? 0.01 : 0.000001;
  if (!Number.isFinite(input.amount) || input.amount < minimum || input.amount > maximum)
    throw badRequest(`Transfer amount must be between ${minimum} and ${maximum} ${input.denomination.toUpperCase()}.`);
  const requestedMon = input.denomination === "usd" ? input.amount / input.priceUsd : input.amount;
  const scaled = BigInt(Math.round(requestedMon * 10 ** MON_DISPLAY_DECIMALS));
  if (scaled <= 0n) throw badRequest("Transfer rounds below the smallest quoted unit.");
  const wei = scaled * 10n ** BigInt(18 - MON_DISPLAY_DECIMALS);
  const amountMon = Number(scaled) / 10 ** MON_DISPLAY_DECIMALS;
  return {
    recipient,
    amountMon: amountMon.toFixed(MON_DISPLAY_DECIMALS).replace(/0+$/, "").replace(/\.$/, ""),
    amountWei: wei.toString(),
    amountUsd: input.denomination === "usd" ? input.amount : amountMon * input.priceUsd,
    priceUsd: input.priceUsd,
    quotedAt: input.quotedAt ?? Date.now()
  };
}
