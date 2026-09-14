import { useEffect, useState } from "react";
import type { IndexedToken } from "../../../shared/tokenIndex";
import { api } from "../../api/client";

export function TokenPicker({ query, onChoose }: { query: string; onChoose: (token: IndexedToken) => void }) {
  const [matches, setMatches] = useState<IndexedToken[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.resolveToken(query).then((result) => { if (live) setMatches(result.matches); }).catch(() => { if (live) setMatches([]); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [query]);
  return <div className="token-picker">
    <p>Couldn’t safely resolve <b>${query.replace(/^\$+/, "")}</b>. Choose a nearby indexed token:</p>
    {loading ? <div className="agent-empty">SEARCHING INDEX…</div> : matches.length ? <div>{matches.map((token) => <button key={`${token.chain}:${token.address}`} type="button" onClick={() => onChoose(token)}>
      {token.imageUrl ? <img src={token.imageUrl} alt="" /> : <i aria-hidden="true" />}
      <span><b>${token.symbol} {token.verified ? <em>VERIFIED</em> : null}</b><small>{token.name || "Unnamed token"} · {token.chain}</small></span><strong>USE →</strong>
    </button>)}</div> : <div className="agent-empty">No close indexed tickers. Paste the contract address.</div>}
  </div>;
}
