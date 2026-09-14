import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import type { PublicConfig } from "./types";
import { DeskPage } from "./pages/DeskPage";
import { AgentLoadingScreen } from "./features/standalone-agent/AgentLoadingScreen";

const loadAgentPage = () => import("./pages/AgentPage").then((module) => ({ default: module.AgentPage }));
const AgentPage = lazy(loadAgentPage);

export default function App() {
  const location = useLocation();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState("");
  const [exiting, setExiting] = useState(false);
  const [showSplash, setShowSplash] = useState(location.pathname === "/agent");
  useEffect(() => {
    let live = true;
    Promise.all([api.config(), ...(location.pathname === "/agent" ? [loadAgentPage()] : [])])
      .then(([loadedConfig]) => { if (live) setConfig(loadedConfig as PublicConfig); })
      .catch((reason) => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!config || !showSplash) return;
    // Keep one clean boot beat even when config is cached, so the cat can decode before its radial dissolve.
    const begin = setTimeout(() => setExiting(true), 950);
    const finish = setTimeout(() => setShowSplash(false), 3100);
    return () => { clearTimeout(begin); clearTimeout(finish); };
  }, [config, showSplash]);
  if (location.pathname !== "/agent" && error) return <main className="loading-state"><h1>BACKEND UNAVAILABLE</h1><p>{error}</p></main>;
  if (location.pathname !== "/agent" && !config) return <main className="loading-state"><span className="loader" /><p>Opening termeow…</p></main>;
  return (
    <div className="app-shell">
      {config && <Routes>
        <Route path="/onchain" element={<DeskPage config={config} />} />
        <Route path="/agent" element={<Suspense fallback={<AgentLoadingScreen />}><AgentPage config={config} /></Suspense>} />
        <Route path="*" element={<Navigate to="/onchain" replace />} />
      </Routes>}
      {location.pathname !== "/agent" && <footer className="product-footer"><span>© 2026 termeow labs</span><nav aria-label="Legal"><a href="#privacy">Privacy policy</a><a href="#terms">Terms</a></nav></footer>}
      {location.pathname === "/agent" && showSplash && <AgentLoadingScreen exiting={exiting} error={error} />}
    </div>
  );
}
