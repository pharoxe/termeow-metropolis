import { PublicKey } from "@solana/web3.js";

export type SolanaTransferDenomination = "usd" | "sol";

export function validateSolanaTransferRecipient(raw: string) {
  const recipient = raw.trim();
  let key: PublicKey;
  try { key = new PublicKey(recipient); }
  catch { throw Object.assign(new Error("Invalid Solana recipient address."), { status: 400 }); }
  if (!PublicKey.isOnCurve(key.toBytes())) throw Object.assign(new Error("Recipient must be an ordinary Solana wallet, not a program-derived address."), { status: 400 });
  return key.toBase58();
}

export async function validateSolanaRecipientAccount(recipient: string, rpcUrl: string, fetchImpl: typeof fetch = fetch) {
  const address = validateSolanaTransferRecipient(recipient);
  const response = await fetchImpl(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(6_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] })
  });
  const body = await response.json() as { result?: { value?: { executable?: boolean; owner?: string } | null }; error?: { message?: string } };
  if (!response.ok || body.error) throw Object.assign(new Error(body.error?.message || "Could not validate the recipient on Solana."), { status: 503 });
  const account = body.result?.value;
  if (account && (account.executable || account.owner !== "11111111111111111111111111111111"))
    throw Object.assign(new Error("Recipient is an existing program or data account, not a standard SOL wallet."), { status: 400 });
  return address;
}

export function computeSolanaTransferQuote(input: { recipient: string; amount: number; denomination: SolanaTransferDenomination; priceUsd: number; quotedAt?: number }) {
  const recipient = validateSolanaTransferRecipient(input.recipient);
  if (!Number.isFinite(input.priceUsd) || input.priceUsd <= 0) throw new Error("SOL/USD price is unavailable.");
  const maximum = input.denomination === "usd" ? 10_000 : 1_000;
  const minimum = input.denomination === "usd" ? 0.01 : 0.000001;
  if (!Number.isFinite(input.amount) || input.amount < minimum || input.amount > maximum)
    throw Object.assign(new Error(`Transfer amount must be between ${minimum} and ${maximum} ${input.denomination.toUpperCase()}.`), { status: 400 });
  const requestedSol = input.denomination === "usd" ? input.amount / input.priceUsd : input.amount;
  const lamports = BigInt(Math.round(requestedSol * 1_000_000_000));
  if (lamports <= 0n) throw Object.assign(new Error("Transfer rounds below one lamport."), { status: 400 });
  const amountSol = Number(lamports) / 1_000_000_000;
  return {
    recipient,
    amountSol: amountSol.toFixed(9).replace(/0+$/, "").replace(/\.$/, ""),
    amountLamports: lamports.toString(),
    amountUsd: input.denomination === "usd" ? input.amount : amountSol * input.priceUsd,
    priceUsd: input.priceUsd,
    quotedAt: input.quotedAt ?? Date.now()
  };
}
