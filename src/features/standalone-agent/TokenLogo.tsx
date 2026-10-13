import { useEffect, useState } from "react";

const knownLogos: Record<string, string> = {
  MON: "/assets/tokens/mon.svg",
  WMON: "/assets/tokens/mon.svg",
  AUSD: "/assets/tokens/ausd.svg",
  ETH: "/assets/tokens/eth.svg",
  WETH: "/assets/tokens/eth.svg",
  USDC: "/assets/tokens/usdc.svg"
};

export function tokenLogoUrl(symbol?: string | null, remote?: string | null) {
  return remote || knownLogos[String(symbol || "").replace(/^\$+/, "").toUpperCase()] || null;
}

export function TokenLogo({ symbol, src, className = "" }: { symbol?: string | null; src?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  const resolved = tokenLogoUrl(symbol, src);
  useEffect(() => setFailed(false), [resolved]);
  if (resolved && !failed) return <img className={`token-logo ${className}`} src={resolved} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
  return <span className={`token-logo token-logo-fallback ${className}`} aria-hidden="true">{String(symbol || "?").replace(/^\$+/, "").slice(0, 1).toUpperCase()}</span>;
}
