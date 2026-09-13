import { getAccessToken } from "@privy-io/react-auth";
import { useEffect, useMemo, useState } from "react";
import type { UserAutomationPreferences } from "../../shared/automation";
import { api } from "../api/client";

type DirectoryTrader = Awaited<ReturnType<typeof api.fomoHandles>>["entries"][number];
type FavoriteToken = NonNullable<UserAutomationPreferences["favoriteTokens"]>[number];

export function TradingOnboarding({ onComplete }: { onComplete: () => void }) {
  const [traders, setTraders] = useState<DirectoryTrader[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [allocation, setAllocation] = useState(5);
  const [ticker, setTicker] = useState("");
  const [tokens, setTokens] = useState<FavoriteToken[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.fomoHandles(500).then((result) => setTraders(result.entries)).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  const shown = useMemo(() => {
    const key = search.trim().replace(/^@/, "").toLowerCase();
    return traders.filter((entry) => !key || entry.handle.toLowerCase().includes(key)).slice(0, key ? 24 : 12);
  }, [search, traders]);

  const addTicker = async (raw = ticker) => {
    const query = raw.trim().replace(/^\$+/, "");
    if (!query) return;
    try {
      const result = await api.resolveToken(query);
      if (!result.match) { setError(result.ambiguous ? "That ticker has multiple matches—add its contract later from your profile." : "That ticker is not indexed yet."); return; }
      const next = { symbol: result.match.symbol, chain: result.match.chain, address: result.match.address, name: result.match.name };
      setTokens((current) => current.some((item) => item.chain === next.chain && item.address === next.address) ? current : [...current, next].slice(0, 25));
      setTicker(""); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const save = async () => {
    if (!selected.length) { setError("Pick at least one trader to track."); return; }
    setSaving(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your login session expired. Log in again.");
      const favoriteTraders = selected.map((wallet) => traders.find((entry) => entry.wallet === wallet)).filter((entry): entry is DirectoryTrader => Boolean(entry)).map((entry) => ({ handle: entry.handle, chain: entry.chain, wallet: entry.wallet, followers: entry.followers }));
      await api.updateAutomationPreferences(token, { favoriteTraders, favoriteTokens: tokens, defaultAllocationPercent: allocation, onboardingCompleted: true });
      onComplete();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  return <dialog className="trading-onboarding" open aria-modal="true" aria-labelledby="trading-onboarding-title">
    <div className="onboarding-kicker">BUILD YOUR TERMEOW MEMORY</div>
    <h2 id="trading-onboarding-title">WHO ARE WE WATCHING?</h2>
    <p>I’ll keep these traders, sizing defaults, and favorite tickers attached to your profile for faster calls next time.</p>
    <label className="trader-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="SEARCH FOMO HANDLE" /></label>
    <div className="onboarding-traders">{shown.map((entry) => {
      const active = selected.includes(entry.wallet);
      return <button key={entry.wallet} type="button" className={active ? "active" : ""} onClick={() => setSelected((current) => active ? current.filter((wallet) => wallet !== entry.wallet) : [...current, entry.wallet].slice(-10))}>
        <i aria-hidden="true" /><span><b>@{entry.handle}</b><small>{entry.followers?.toLocaleString() || "—"} followers</small></span><em>{active ? "✓" : "+"}</em>
      </button>;
    })}</div>
    <div className="onboarding-preferences">
      <label><span>DEFAULT TRADE SIZE</span><select value={allocation} onChange={(event) => setAllocation(Number(event.target.value))}><option value={1}>1% of wallet</option><option value={2.5}>2.5% of wallet</option><option value={5}>5% of wallet</option><option value={10}>10% of wallet</option><option value={15}>15% of wallet</option><option value={25}>25% of wallet</option></select></label>
      <label><span>FAVORITE TICKERS <small>OPTIONAL</small></span><div><input value={ticker} onChange={(event) => setTicker(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addTicker(); } }} placeholder="$ANSEM" /><button type="button" onClick={() => void addTicker()}>ADD</button></div></label>
    </div>
    <div className="onboarding-token-chips">{tokens.map((token) => <button type="button" key={`${token.chain}:${token.address}`} onClick={() => setTokens((current) => current.filter((item) => item !== token))}>${token.symbol} ×</button>)}</div>
    {error && <p className="onboarding-error">{error}</p>}
    <button className="onboarding-save" type="button" disabled={saving || !traders.length} onClick={() => void save()}>{saving ? "SAVING MEMORY…" : "SAVE & CONTINUE →"}</button>
  </dialog>;
}
