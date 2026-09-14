import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";

type PickerEntry = {
  chain: "solana" | "robinhood"; wallet: string; rank: number; handle: string;
  displayName?: string | null; twitter?: string | null; avatarUrl?: string | null;
  followers?: number | null; profileUrl?: string | null;
};

export function HandlePicker({ initialQuery = "", onChoose }: { initialQuery?: string; onChoose: (handle: string) => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [entries, setEntries] = useState<PickerEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([
      api.identityBoard("fomoscan-traders", "24h", 100).catch(() => null),
      api.fomoHandles(500).catch(() => null)
    ]).then(([stored, liveDirectory]) => {
      const merged = new Map<string, PickerEntry>();
      stored?.entries.forEach((entry) => {
        if (!entry.identity?.handle) return;
        merged.set(entry.identity.handle.toLowerCase(), { chain: entry.chain, wallet: entry.wallet, rank: entry.rank, handle: entry.identity.handle, displayName: entry.identity.displayName, twitter: entry.identity.twitter, avatarUrl: entry.identity.avatarUrl, followers: entry.identity.followers });
      });
      liveDirectory?.entries.forEach((entry, index) => {
        if (!entry.handle || merged.has(entry.handle.toLowerCase())) return;
        merged.set(entry.handle.toLowerCase(), { chain: entry.chain, wallet: entry.wallet, rank: index + 1, handle: entry.handle, followers: entry.followers, profileUrl: entry.profileUrl });
      });
      if (live) { setEntries([...merged.values()]); setError(""); }
    }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, []);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  const rows = useMemo(() => {
    const key = query.trim().replace(/^@/, "").toLowerCase();
    return entries.filter((entry) => {
      return !key || [entry.handle, entry.displayName, entry.twitter].some((value) => value?.toLowerCase().includes(key));
    }).slice(0, 16);
  }, [entries, query]);
  return <div className="handle-picker">
    <label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="SEARCH FOMO HANDLE" autoFocus /></label>
    <div>{rows.length ? rows.map((entry) => {
      const handle = entry.handle.replace(/^@/, "");
      return <article key={`${entry.chain}:${entry.wallet}`}>
        <button type="button" onClick={() => onChoose(handle)}>{entry.avatarUrl ? <img src={entry.avatarUrl} alt="" /> : <i aria-hidden="true" />}<span><b>@{handle}</b><small>#{entry.rank} · {entry.chain.toUpperCase()}{entry.followers ? ` · ${entry.followers.toLocaleString()} followers` : ""}</small></span></button>
        <span className="picker-socials"><a href={entry.profileUrl || `https://fomo.family/profile/${encodeURIComponent(handle)}`} target="_blank" rel="noreferrer" aria-label={`Open ${handle} on Fomo`}><img src="/assets/fomo-logo.png" alt="" /></a>{entry.twitter ? <a href={/^https?:/i.test(entry.twitter) ? entry.twitter : `https://x.com/${entry.twitter.replace(/^@/, "")}`} target="_blank" rel="noreferrer" aria-label={`Open ${handle} on X`}><img src="/assets/x-logo.png" alt="" /></a> : null}</span>
      </article>;
    }) : <p>{error || "NO INDEXED MATCH"}</p>}</div>
  </div>;
}
