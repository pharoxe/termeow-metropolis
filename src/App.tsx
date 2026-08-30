import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api/client";
import type { PublicConfig } from "./types";
import { AppHeader } from "./components/AppHeader";
import { OnchainPage } from "./pages/OnchainPage";
import { PerpsPage } from "./pages/PerpsPage";

export default function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.config().then(setConfig).catch((reason) => setError(String(reason))); }, []);
  if (error) return <main className="loading-state"><h1>BACKEND UNAVAILABLE</h1><p>{error}</p></main>;
  if (!config) return <main className="loading-state"><span className="loader" /><p>Booting Solana terminal…</p></main>;
  return (
    <div className="app-shell">
      <AppHeader />
      <Routes>
        <Route path="/onchain" element={<OnchainPage config={config} />} />
        <Route path="/perps" element={<PerpsPage config={config} />} />
        <Route path="*" element={<Navigate to="/onchain" replace />} />
      </Routes>
      <footer>UNVALIDATED RESEARCH · MAINNET EXECUTION REQUIRES EXPLICIT WALLET OR AGENT APPROVAL · DATA SOURCES ARE LABELLED</footer>
    </div>
  );
}
