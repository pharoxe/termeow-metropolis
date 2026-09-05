import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";

// Add a definition here, then wrap its surface in FeatureSection.
export const FEATURES = [
  { id: "flow", title: "Order flow", description: "Live trade tape and buy / sell activity." },
  { id: "pools", title: "LP pool info", description: "Pool liquidity, venues and distribution." },
  { id: "social", title: "Social trading insights", description: "KOL signals, token narratives and social links." },
  { id: "execution", title: "Trade execution", description: "Wallet-signed spot orders and agentic perp execution. Every trade still requires approval." },
  { id: "research", title: "Market research", description: "News, market context and contract information." }
] as const;
export type FeatureId = typeof FEATURES[number]["id"];
const KEY = "termeow-workspace-v1";
function readPreferences(): FeatureId[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || "null");
    return Array.isArray(value) ? FEATURES.filter(f => value.includes(f.id)).map(f => f.id) : null;
  } catch { return null; }
}
const Context = createContext<{ selected: FeatureId[]; customize: () => void; onboard: () => void }>({ selected: FEATURES.map(f => f.id), customize: () => {}, onboard: () => {} });
export const useWorkspaceFeatures = () => useContext(Context);

export function WorkspaceFeatures({ children }: PropsWithChildren) {
  const [saved, setSaved] = useState(readPreferences);
  const [draft, setDraft] = useState<FeatureId[]>(saved || FEATURES.map(f => f.id));
  const dialog = useRef<HTMLDialogElement>(null);
  const open = () => { setDraft(saved || FEATURES.map(f => f.id)); dialog.current?.showModal(); };
  const save = () => {
    setSaved(draft);
    try { localStorage.setItem(KEY, JSON.stringify(draft)); } catch { /* session preferences remain available */ }
    dialog.current?.close();
  };
  return <Context.Provider value={{ selected: saved ?? FEATURES.map(f => f.id), customize: open, onboard: () => { if (saved === null) open(); } }}>
    {children}
    <dialog ref={dialog} className="onboarding-dialog" aria-labelledby="onboarding-title">
      <div className="onboarding-head"><span className="brand">termeow / your workspace</span><button aria-label="Close customization" onClick={() => dialog.current?.close()}>×</button></div>
      <h2 id="onboarding-title">Make yourself at home.</h2>
      <p>Choose what stays open on your desk. Everything else stays one click away in an expandable section.</p>
      <div className="feature-choices">{FEATURES.map(feature => <label key={feature.id} className={draft.includes(feature.id) ? "chosen" : ""}>
        <input type="checkbox" checked={draft.includes(feature.id)} onChange={e => setDraft(current => e.target.checked ? [...current, feature.id] : current.filter(id => id !== feature.id))} />
        <span><strong>{feature.title}</strong><small>{feature.description}</small></span>
      </label>)}</div>
      <div className="onboarding-actions"><button onClick={() => setDraft(FEATURES.map(f => f.id))}>Select all</button><button onClick={() => setDraft([])}>Clear all</button><button className="finish-onboarding" onClick={save}>Save workspace →</button></div>
      <small>You can change these choices anytime with Customize.</small>
    </dialog>
  </Context.Provider>;
}

export function FeatureSection({ id, className = "", children }: PropsWithChildren<{ id: FeatureId; className?: string }>) {
  const { selected } = useWorkspaceFeatures();
  const enabled = selected.includes(id);
  const [expanded, setExpanded] = useState(enabled);
  useEffect(() => setExpanded(enabled), [enabled]);
  const feature = FEATURES.find(item => item.id === id)!;
  return <section className={`feature-section ${className} ${expanded ? "is-expanded" : "is-collapsed"}`}>
    <button className="feature-disclosure" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span>{feature.title}</span><span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
    <div hidden={!expanded}>{children}</div>
  </section>;
}
