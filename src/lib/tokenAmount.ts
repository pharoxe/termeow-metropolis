/** Exact conversion; reject excess precision rather than silently changing an order. */
export function tokenAmount(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Token decimals unavailable");
  if (!/^\d+(\.\d*)?$/.test(value)) throw new Error("Enter a positive token amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.slice(decimals).replace(/0/g, "")) throw new Error(`This token supports ${decimals} decimal places`);
  const units = BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
  if (units <= 0n || units > 18446744073709551615n) throw new Error("Token amount is outside the supported range");
  return units.toString();
}
