import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { shortAddress } from "../../lib/format";

type PickerEntry = { chain: "monad"; wallet: string; rank: number; label: string; source: string; profileUrl?: string | null };

/**
 * Directory of labelled Monad wallets: Nansen smart-money labels seen on Monad plus the user's watchlist. Labels such as
 * "Smart Trader" repeat across wallets, so a choice hands back the exact wallet with its label, never the label alone.
 */
export function HandlePicker({ initialQuery = "", onChoose }: { initialQuery?: string; onChoose: (choice: { wallet: string; label: string }) => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [entries, setEntries] = useState<PickerEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api.smartHandles(500).then((directory) => {
      if (!live) return;
      setEntries(directory.entries.map((entry, index) => ({ chain: "monad", wallet: entry.wallet, rank: index + 1, label: entry.handle, source: entry.source, profileUrl: entry.profileUrl })));
      setError("");
    }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, []);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  const rows = useMemo(() => {
    const key = query.trim().replace(/^@/, "").toLowerCase();
    return entries.filter((entry) => !key || entry.label.toLowerCase().includes(key) || entry.wallet.includes(key)).slice(0, 16);
  }, [entries, query]);
  return <div className="handle-picker">
    <label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SEARCH LABEL OR WALLET" autoFocus /></label>
    <div>{rows.length ? rows.map((entry) => <article key={`${entry.chain}:${entry.wallet}`}>
      <button type="button" onClick={() => onChoose({ wallet: entry.wallet, label: entry.label })}><i aria-hidden="true" /><span><b>{entry.label}</b><small>{shortAddress(entry.wallet)} · {entry.source === "nansen" ? "NANSEN" : entry.source.toUpperCase()}</small></span></button>
      <span className="picker-socials"><a href={entry.profileUrl || `https://app.nansen.ai/profiler?chain=monad&address=${entry.wallet}`} target="_blank" rel="noreferrer" aria-label={`Open ${entry.label} on Nansen`}>NANSEN ↗</a></span>
    </article>) : <p>{error || (entries.length ? "NO MATCH" : "NO LABELLED WALLETS YET · SET NANSEN_API_KEY OR WATCH A WALLET")}</p>}</div>
  </div>;
}
