import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import type { PublicConfig } from "./types";
import { DeskPage } from "./pages/DeskPage";
import { AgentLoadingScreen } from "./features/standalone-agent/AgentLoadingScreen";

const loadAgentPage = () => import("./pages/AgentPage").then((module) => ({ default: module.AgentPage }));
const AgentPage = lazy(loadAgentPage);

/** The agent is the front door; the terminal lives at /onchain. Anything else lands on the agent. */
const isAgentPath = (pathname: string) => pathname !== "/onchain";

export default function App() {
  const location = useLocation();
  const agentRoute = isAgentPath(location.pathname);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState("");
  const [exiting, setExiting] = useState(false);
  const [showSplash, setShowSplash] = useState(agentRoute);
  useEffect(() => {
    let live = true;
    Promise.all([api.config(), ...(agentRoute ? [loadAgentPage()] : [])])
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
  if (!agentRoute && error) return <main className="loading-state"><h1>BACKEND UNAVAILABLE</h1><p>{error}</p></main>;
  if (!agentRoute && !config) return <main className="loading-state"><span className="loader" /><p>Opening termeow…</p></main>;
  return (
    <div className="app-shell">
      {config && <Routes>
        <Route path="/onchain" element={<DeskPage config={config} />} />
        <Route path="/agent" element={<Suspense fallback={<AgentLoadingScreen />}><AgentPage config={config} /></Suspense>} />
        <Route path="*" element={<Navigate to={{ pathname: "/agent", search: location.search }} replace />} />
      </Routes>}
      {!agentRoute && <footer className="product-footer"><span>© 2026 termeow labs</span><nav aria-label="Legal"><a href="#privacy">Privacy policy</a><a href="#terms">Terms</a></nav></footer>}
      {agentRoute && showSplash && <AgentLoadingScreen exiting={exiting} error={error} />}
    </div>
  );
}
