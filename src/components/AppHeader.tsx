import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { AuthControls } from "../auth/AuthControls";

export function AppHeader() {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const update = () => setClock(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <header className="app-header">
        <div className="brand">
          <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="tv-v-sol" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffd98a"/><stop offset="1" stopColor="#e08a1e"/></linearGradient></defs><rect className="lm-chip" x=".9" y=".9" width="26.2" height="26.2" rx="6.2"/><path className="lm-path" d="M8.2 6.4 L14 18.9 L19.8 6.4"/><line className="lm-limit" x1="6" y1="22.6" x2="22" y2="22.6"/><path className="lm-ghost" d="M11.4 25.6 L14 23.4 L16.6 25.6"/><circle className="lm-tip" cx="14" cy="18.9" r="1.9"/></svg>
          <span>TERMINAL</span><strong>V</strong><b>SOL</b>
        </div>
        <input className="command-input" value="ANSEM" readOnly aria-label="Selected instrument" />
        <nav className="mode-switch" aria-label="Trading product">
          <NavLink to="/onchain">ONCHAIN</NavLink>
          <NavLink to="/perps">PERPS</NavLink>
        </nav>
        <div className="network"><span className="status-dot live" />SOLANA MAINNET <time>{clock} IST</time></div>
        <AuthControls />
      </header>
      <div className="risk-banner">MAINNET · USER-SIGNED SPOT · CLAWPUMP INTELLIGENCE · VERIFY MINTS, ROUTES AND SIMULATION BEFORE CONFIRMING</div>
    </>
  );
}
